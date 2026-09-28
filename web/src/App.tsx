import { Actions } from "./components/Actions";
import { Audience } from "./components/Audience";
import { Custom } from "./components/Custom";
import { Download } from "./components/Download";
import { Faq } from "./components/Faq";
import { Footer } from "./components/Footer";
import { Gallery } from "./components/Gallery";
import { Hero } from "./components/Hero";
import { Nav } from "./components/Nav";
import { Ocr } from "./components/Ocr";
import { Position } from "./components/Position";
import { Trust } from "./components/Trust";

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Actions />
        <Ocr />
        <Gallery />
        <Audience />
        <Custom />
        <Position />
        <Trust />
        <Download />
        <Faq />
      </main>
      <Footer />
    </>
  );
}
