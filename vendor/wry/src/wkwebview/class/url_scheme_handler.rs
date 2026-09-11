// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  borrow::Cow,
  ffi::{c_char, c_void, CStr},
  panic::AssertUnwindSafe,
  ptr::NonNull,
};

use http::{
  header::{CONTENT_LENGTH, CONTENT_TYPE},
  Request, Response as HttpResponse, StatusCode, Version,
};
use objc2::{
  rc::Retained,
  runtime::{AnyClass, AnyObject, ClassBuilder, ProtocolObject},
  AllocAnyThread, ClassType, Message,
};
use objc2_foundation::{
  NSData, NSHTTPURLResponse, NSMutableDictionary, NSObject, NSObjectProtocol, NSString, NSURL,
  NSUUID,
};
use objc2_web_kit::{WKURLSchemeHandler, WKURLSchemeTask};

use crate::{wkwebview::WEBVIEW_STATE, RequestAsyncResponder, WryWebView};

pub fn create(name: &str) -> &AnyClass {
  unsafe {
    // Include the address of WEBVIEW_STATE in the class name so that each dylib in the process
    // gets its own ObjC class with method pointers into its own code and data segments.
    let unique_id = std::ptr::addr_of!(WEBVIEW_STATE) as usize;
    let scheme_name = format!("{name}URLSchemeHandler_{unique_id:x}\0");
    let scheme_name = CStr::from_bytes_with_nul(scheme_name.as_bytes()).unwrap();
    let cls = ClassBuilder::new(scheme_name, NSObject::class());
    match cls {
      Some(mut cls) => {
        cls.add_ivar::<*mut c_char>(c"webview_id");
        cls.add_ivar::<usize>(c"protocol_index");
        cls.add_method(
          objc2::sel!(webView:startURLSchemeTask:),
          start_task as extern "C" fn(_, _, _, _),
        );
        cls.add_method(
          objc2::sel!(webView:stopURLSchemeTask:),
          stop_task as extern "C" fn(_, _, _, _),
        );
        cls.register()
      }
      None => AnyClass::get(scheme_name).expect("Failed to get the class definition"),
    }
  }
}

// Task handler for custom protocol.
//
// magpie 本地补丁：handler 由 WebKit 经 extern "C" 调用，内部任何 panic 都无法
// unwind（直接 abort 整个进程，见 wry#1752 / tauri#12338）。因此整体包一层
// catch_unwind：任何内部 panic 都降级为「忽略该任务」并打印原因，进程不再崩。
extern "C" fn start_task(
  this: &AnyObject,
  _sel: objc2::runtime::Sel,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    start_task_impl(this, webview, task);
  }));
  if let Err(payload) = result {
    let msg = payload
      .downcast_ref::<&'static str>()
      .map(|s| (*s).to_string())
      .or_else(|| payload.downcast_ref::<String>().cloned())
      .unwrap_or_else(|| "unknown panic".into());
    eprintln!("[wry:scheme] start_task panicked, task ignored: {msg}");
  }
}

fn start_task_impl(
  this: &AnyObject,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  unsafe {
    #[cfg(feature = "tracing")]
    let span = tracing::info_span!(parent: None, "wry::custom_protocol::handle", uri = tracing::field::Empty)
      .entered();

    let task_key = task.hash(); // hash by task object address
    let task_uuid = webview.add_custom_task_key(task_key);

    // magpie 本地补丁（wry#1752）：本 handler 由 extern "C" 调用，任何 panic 都会
    // 直接 abort 整个进程。以下将上游所有 unwrap 改为记日志 + 忽略任务。
    let Some(ivar) = this.class().instance_variable(c"webview_id") else {
      eprintln!("[wry:scheme] webview_id ivar missing, ignoring task");
      return;
    };
    let webview_id_ptr: *mut c_char = *ivar.load(this);
    if webview_id_ptr.is_null() {
      eprintln!("[wry:scheme] webview_id is null, ignoring task");
      return;
    }
    let webview_id = CStr::from_ptr(webview_id_ptr)
      .to_str()
      .ok()
      .unwrap_or_default();

    let Some(ivar) = this.class().instance_variable(c"protocol_index") else {
      eprintln!("[wry:scheme] protocol_index ivar missing, ignoring task");
      return;
    };
    let protocol_index: usize = *ivar.load(this);

    let function = WEBVIEW_STATE
      .read()
      .unwrap()
      .get(webview_id)
      .and_then(|v| v.protocol_ptrs.get(protocol_index))
      .cloned();

    if let Some(function) = function {
      // Get url request
      let request = task.request();
      // WebKit may dispatch custom-scheme tasks whose request has nil URL,
      // absoluteString, or HTTPMethod. Unwrapping them aborts across the FFI
      // boundary (panic in extern "C"), so bail out (or fall back to GET) instead.
      // Local patch of upstream PR #1744 / issue #1752.
      let Some(url) = request.URL() else {
        eprintln!("[wry:scheme] task has nil URL, ignoring");
        return;
      };

      let Some(absolute_uri) = url.absoluteString() else {
        eprintln!("[wry:scheme] task URL has nil absoluteString, ignoring");
        return;
      };
      let uri = absolute_uri.to_string();

      #[cfg(feature = "tracing")]
      span.record("uri", uri.clone());

      // Get request method (GET, POST, PUT etc...)
      let method = match request.HTTPMethod() {
        Some(m) => m.to_string(),
        None => "GET".to_string(),
      };

      // Prepare our HttpRequest
      let mut http_request = Request::builder().uri(uri).method(method.as_str());

      // Get body
      let mut sent_form_body = Vec::new();
      let body = request.HTTPBody();
      let body_stream = request.HTTPBodyStream();
      if let Some(body) = body {
        sent_form_body = body.to_vec();
      } else if let Some(body_stream) = body_stream {
        body_stream.open();

        while body_stream.hasBytesAvailable() {
          sent_form_body.reserve(128);
          let p = sent_form_body.as_mut_ptr().add(sent_form_body.len());
          let Some(ptr) = NonNull::new(p) else {
            break;
          };
          let read_length = sent_form_body.capacity() - sent_form_body.len();
          let count = body_stream.read_maxLength(ptr, read_length);
          sent_form_body.set_len(sent_form_body.len() + count as usize);
        }

        body_stream.close();
      }

      // Extract all headers fields
      let all_headers = request.allHTTPHeaderFields();

      // get all our headers values and inject them in our request
      if let Some(all_headers) = all_headers {
        for current_header in all_headers.allKeys().iter() {
          // Skip headers whose value is nil rather than aborting the task.
          if let Some(header_value) = all_headers.valueForKey(&current_header) {
            // inject the header into the request
            http_request =
              http_request.header(current_header.to_string(), header_value.to_string());
          }
        }
      }

      let respond_with_404 = || {
        let urlresponse = NSHTTPURLResponse::alloc();
        let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
          urlresponse,
          &url,
          StatusCode::NOT_FOUND.as_u16().try_into().unwrap_or(404),
          Some(&NSString::from_str(
            format!("{:#?}", Version::HTTP_11).as_str(),
          )),
          None,
        );
        let Some(response) = response else {
          return;
        };
        task.didReceiveResponse(&response);
        // Finish
        task.didFinish();
      };

      fn check_webview_id_valid(webview_id: &str) -> crate::Result<()> {
        if !WEBVIEW_STATE.read().unwrap().contains_key(webview_id) {
          return Err(crate::Error::CustomProtocolTaskInvalid);
        }
        Ok(())
      }

      /// Task may not live longer than async custom protocol handler.
      ///
      /// There are roughly 2 ways to cause segfault:
      /// 1. Task has stopped. pointer of the task not valid anymore.
      /// 2. Task had stopped, but the pointer of the task has allocated to a new task.
      ///    Outdated custom handler may call to the new task instance and cause segfault.
      fn check_task_is_valid(
        webview: &WryWebView,
        task_key: usize,
        current_uuid: Retained<NSUUID>,
      ) -> crate::Result<()> {
        let latest_task_uuid = webview.get_custom_task_uuid(task_key);
        let Some(latest_uuid) = latest_task_uuid else {
          return Err(crate::Error::CustomProtocolTaskInvalid);
        };
        if latest_uuid != current_uuid {
          return Err(crate::Error::CustomProtocolTaskInvalid);
        }
        Ok(())
      }

      // send response
      match http_request.body(sent_form_body) {
        Ok(final_request) => {
          let webview = webview.retain();
          let task = task.retain();
          let responder: Box<dyn FnOnce(HttpResponse<Cow<'static, [u8]>>)> =
            Box::new(move |sent_response| {
              // Consolidate checks before calling into `did*` methods.
              let validate = || -> crate::Result<()> {
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;
                Ok(())
              };

              // Perform an upfront validation
              if let Err(_e) = validate() {
                #[cfg(feature = "tracing")]
                tracing::warn!("Task invalid before sending response: {:?}", _e);
                return; // If invalid, return early without calling task methods.
              }

              unsafe fn response(
                // FIXME: though we give it a static lifetime, it's not guaranteed to be valid.
                task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
                // FIXME: though we give it a static lifetime, it's not guaranteed to be valid.
                webview: Retained<WryWebView>,
                task_key: usize,
                task_uuid: Retained<NSUUID>,
                webview_id: &str,
                url: Retained<NSURL>,
                sent_response: HttpResponse<Cow<'_, [u8]>>,
              ) -> crate::Result<()> {
                // Validate
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                let content = sent_response.body();
                // default: application/octet-stream, but should be provided by the client
                let wanted_mime = sent_response.headers().get(CONTENT_TYPE);
                // default to 200
                let wanted_status_code = sent_response.status().as_u16() as i32;
                // default to HTTP/1.1
                let wanted_version = format!("{:#?}", sent_response.version());

                let headers = NSMutableDictionary::new();
                if let Some(mime) = wanted_mime {
                  if let Ok(mime_str) = mime.to_str() {
                    headers.insert(
                      &*NSString::from_str(CONTENT_TYPE.as_str()),
                      &*NSString::from_str(mime_str),
                    );
                  }
                }
                headers.insert(
                  &*NSString::from_str(CONTENT_LENGTH.as_str()),
                  &*NSString::from_str(&content.len().to_string()),
                );

                // add headers
                for (name, value) in sent_response.headers().iter() {
                  if let Ok(value) = value.to_str() {
                    headers.insert(
                      &*NSString::from_str(name.as_str()),
                      &*NSString::from_str(value),
                    );
                  }
                }

                let urlresponse = NSHTTPURLResponse::alloc();
                let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
                  urlresponse,
                  &url,
                  wanted_status_code.try_into().unwrap_or(200),
                  Some(&NSString::from_str(&wanted_version)),
                  Some(&headers),
                );
                let Some(response) = response else {
                  return Err(crate::Error::CustomProtocolTaskInvalid);
                };

                // Re-validate before calling didReceiveResponse
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                // Use map_err to convert Option<Retained<Exception>> to crate::Error
                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didReceiveResponse(&response);
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                // Send data
                let data = NSData::alloc();
                // MIGRATE NOTE: we copied the content to the NSData because content will be freed
                // when out of scope but NSData will also free the content when it's done and cause doube free.
                let data = NSData::initWithBytes_length(
                  data,
                  content.as_ptr() as *mut c_void,
                  content.len(),
                );

                // Check validity again
                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid.clone())?;

                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didReceiveData(&data);
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                check_webview_id_valid(webview_id)?;
                check_task_is_valid(&webview, task_key, task_uuid)?;

                objc2::exception::catch(AssertUnwindSafe(|| {
                  task.didFinish();
                }))
                .map_err(|_e| crate::Error::CustomProtocolTaskInvalid)?;

                if WEBVIEW_STATE.read().unwrap().contains_key(webview_id) {
                  webview.remove_custom_task_key(task_key);
                  Ok(())
                } else {
                  Err(crate::Error::CustomProtocolTaskInvalid)
                }
              }

              #[cfg(feature = "tracing")]
              let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

              if let Err(_e) = response(
                task,
                webview,
                task_key,
                task_uuid,
                webview_id,
                url,
                sent_response,
              ) {
                #[cfg(feature = "tracing")]
                tracing::error!("Error responding to task: {:?}", _e);
              }
            });

          #[cfg(feature = "tracing")]
          let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

          function(
            webview_id,
            final_request,
            RequestAsyncResponder { responder },
          );
        }
        Err(_) => respond_with_404(),
      };
    } else {
      #[cfg(feature = "tracing")]
      tracing::warn!(
        "Either WebView or WebContext instance is dropped! This handler shouldn't be called."
      );
    };
  }
}

extern "C" fn stop_task(
  _this: &ProtocolObject<dyn WKURLSchemeHandler>,
  _sel: objc2::runtime::Sel,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    webview.remove_custom_task_key(task.hash());
  }));
  if result.is_err() {
    eprintln!("[wry:scheme] stop_task panicked, ignored");
  }
}
