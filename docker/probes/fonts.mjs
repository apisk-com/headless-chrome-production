// Prints the fonts that Chrome uses for Arabic text: once with the generic
// family "sans-serif", once with the font named in CSS.
import { launch, library, newPage } from './launch.mjs';

const browser = await launch();
const page = await newPage(browser, { width: 800, height: 200 });
await page.setContent(`<meta charset="utf-8">
  <p id="generic" style="font-family: sans-serif">مرحبا</p>
  <p id="named" style="font-family: 'Noto Sans Arabic', sans-serif">مرحبا</p>`);
const session = library === 'playwright'
  ? await page.context().newCDPSession(page)
  : await page.createCDPSession();
await session.send('DOM.enable');
await session.send('CSS.enable');
const { root } = await session.send('DOM.getDocument');
for (const id of ['generic', 'named']) {
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${id}` });
  const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
  console.log(`${library}, ${id}: ${fonts.map((font) => font.familyName).join(', ')}`);
}
await browser.close();
