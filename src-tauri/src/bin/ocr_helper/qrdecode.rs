//! 二维码解码（纯 Rust，两平台共用）：截图里常出现二维码（登录、网页、WiFi），
//! 本机解码后随 OCR 结果一并返回，零模型额度、离线可用。
//! 解码失败（无码/码不完整/读不了文件）一律返回空 Vec——对上层静默，
//! 不作为错误（与「捕获失败静默」同一边界）。
//! 只解 QR（rqrr 的能力边界）；DataMatrix 等其他码制有需求再换 rxing。

use std::path::Path;

/// 解码图片文件里的全部二维码（任意 image crate 支持的格式）
pub fn decode_image_file(path: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    decode_png_bytes(&raw)
}

/// 解码图片字节里的全部二维码，去重保序（同一码在图里出现两次只算一条）。
/// 尝试顺序：缩放图 → 原图 → 反色缩放图 → 反色原图。前两档管「码太小被
/// 缩没了」，后两档管暗色模式的白码黑底（rqrr 只认深色模块在浅底上的
/// 标准形态）。全空 = 图里没有可解的码，对上层静默
pub fn decode_png_bytes(raw: &[u8]) -> Vec<String> {
    let Ok(img) = image::load_from_memory(raw) else {
        return Vec::new();
    };
    // 长边超限先等比缩小：rqrr 预处理（二值化）是像素级成本，大图显著变慢
    const MAX_EDGE: u32 = 1600;
    let long = img.width().max(img.height());
    let scaled = (long > MAX_EDGE)
        .then(|| img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Triangle));
    let mut out = Vec::new();
    for inverted in [false, true] {
        let view = scaled.as_ref().unwrap_or(&img);
        out = decode_gray(to_luma(view, inverted));
        if !out.is_empty() {
            return out;
        }
        if scaled.is_some() {
            out = decode_gray(to_luma(&img, inverted));
            if !out.is_empty() {
                return out;
            }
        }
    }
    out
}

/// 灰度化，可反色（暗色模式的码是浅色模块压在深底上，反转后才是 rqrr 认的形态）
fn to_luma(img: &image::DynamicImage, inverted: bool) -> image::GrayImage {
    let mut gray = img.to_luma8();
    if inverted {
        for px in gray.iter_mut() {
            *px = 255 - *px;
        }
    }
    gray
}

fn decode_gray(gray: image::GrayImage) -> Vec<String> {
    let mut prepared = rqrr::PreparedImage::prepare(gray);
    let mut out: Vec<String> = Vec::new();
    for grid in prepared.detect_grids() {
        if let Ok((_, text)) = grid.decode() {
            if !text.is_empty() && !out.contains(&text) {
                out.push(text);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GrayImage;
    use qrcode::QrCode;

    /// 生成单个二维码的 PNG 字节（可反色）
    fn qr_png(text: &str, inverted: bool) -> Vec<u8> {
        let code = QrCode::new(text.as_bytes()).unwrap();
        let mut img = code
            .render::<image::Luma<u8>>()
            .quiet_zone(true)
            .build();
        if inverted {
            for px in img.iter_mut() {
                *px = 255 - *px;
            }
        }
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    /// 两张码并排拼进一张图（模拟一帧多码）
    fn two_codes_png(a_text: &str, b_text: &str) -> Vec<u8> {
        let a = QrCode::new(a_text.as_bytes())
            .unwrap()
            .render::<image::Luma<u8>>()
            .quiet_zone(true)
            .build();
        let b = QrCode::new(b_text.as_bytes())
            .unwrap()
            .render::<image::Luma<u8>>()
            .quiet_zone(true)
            .build();
        let w = a.width() + b.width() + 30;
        let h = a.height().max(b.height()) + 20;
        let mut canvas = GrayImage::new(w, h);
        image::imageops::overlay(&mut canvas, &a, 10, 10);
        image::imageops::overlay(&mut canvas, &b, (a.width() + 20) as i64, 10);
        let mut out = std::io::Cursor::new(Vec::new());
        canvas.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn decodes_url() {
        let s = decode_png_bytes(&qr_png("https://magpie.app/hello", false));
        assert_eq!(s, vec!["https://magpie.app/hello".to_string()]);
    }

    #[test]
    fn decodes_wifi_payload() {
        let s = decode_png_bytes(&qr_png("WIFI:T:WPA;S:Magpie;P:pa55word;;", false));
        assert_eq!(s, vec!["WIFI:T:WPA;S:Magpie;P:pa55word;;".to_string()]);
    }

    #[test]
    fn decodes_inverted() {
        let s = decode_png_bytes(&qr_png("https://magpie.app/dark", true));
        assert_eq!(s, vec!["https://magpie.app/dark".to_string()]);
    }

    #[test]
    fn decodes_two_codes() {
        let s = decode_png_bytes(&two_codes_png(
            "https://a.example/1",
            "https://b.example/2",
        ));
        assert_eq!(
            s,
            vec![
                "https://a.example/1".to_string(),
                "https://b.example/2".to_string()
            ]
        );
    }

    #[test]
    fn blank_image_yields_empty() {
        let img = GrayImage::new(300, 300);
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        assert!(decode_png_bytes(&out.into_inner()).is_empty());
    }

    #[test]
    fn garbage_bytes_yield_empty() {
        assert!(decode_png_bytes(b"not an image").is_empty());
    }
}
