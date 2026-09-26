#!/usr/bin/env node
/**
 * Feature demo reports: one screenshot per navigation or action, written as
 * a Word document of ordered steps (a caption, then its image), with a steps
 * manifest beside it (<report>.steps.json) that the spec verifier checks.
 * No dependencies: the .docx is a zip written here.
 *
 * In a Playwright test:
 *   import { createDemoRecorder } from "<this file>";
 *   const demo = createDemoRecorder({ dir: "artifacts/d24-steps" });
 *   await page.goto(url);            await demo.step(page, "Open the orders page", "the empty orders list");
 *   await page.click("text=New");    await demo.step(page, "Click New order", "the order form");
 *   await demo.finish({ out: "artifacts/d24.docx", title: "D24: packing slip" });
 *
 * From recorded steps: node demo-report.mjs --steps steps.json --out report.docx [--title "..."]
 * (steps.json: { "steps": [{ "action": "...", "shows": "...", "image": "path.png" }] })
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of { name, data, compress? } entries (stored, or deflated when asked). */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.compress ? 8 : 0;
    const body = entry.compress ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Pixel size of a PNG or JPEG image. */
export function imageSize(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: "png" };
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) return undefined;
      const marker = buffer[at + 1];
      const length = buffer.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5), type: "jpeg" };
      at += 2 + length;
    }
  }
  return undefined;
}

const escapeXml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MAX_WIDTH_EMU = 5_486_400; // 6 inches
const EMU_PER_PIXEL = 9525;

function paragraph(text, { bold = false, style } = {}) {
  return `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function imageParagraph(id, relationId, size) {
  let cx = size.width * EMU_PER_PIXEL;
  let cy = size.height * EMU_PER_PIXEL;
  if (cx > MAX_WIDTH_EMU) {
    cy = Math.round((cy * MAX_WIDTH_EMU) / cx);
    cx = MAX_WIDTH_EMU;
  }
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Step ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="step-${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

/** The caption of step n: "Step n - <action>: <what it shows>". */
export function stepCaption(step, n) {
  return `Step ${n} - ${step.action}${step.shows ? `: ${step.shows}` : ""}`;
}

/**
 * Build the .docx for ordered steps ({ action, shows, image }) and return it
 * with the steps manifest. `captions: false` on a step (tests only) omits its
 * caption; `compress` deflates document.xml, as Word itself does.
 */
export async function buildDemoReport({ title, steps, compress = false }) {
  const loaded = [];
  for (const step of steps) loaded.push({ ...step, data: Buffer.isBuffer(step.data) ? step.data : await readFile(step.image) });
  return assembleDemo({ title, steps: loaded, compress });
}

/** The same, from steps that carry their image bytes (`data`). */
export function assembleDemo({ title, steps, compress = false }) {
  const media = [];
  const body = [paragraph(title ?? "Feature demo", { bold: true, style: "Title" })];
  const relationships = [];
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    const data = step.data;
    const size = imageSize(data);
    if (!size) throw new Error(`Step ${n}: ${step.image ?? "the image"} is not a PNG or JPEG.`);
    const name = `image${n}.${size.type === "jpeg" ? "jpeg" : "png"}`;
    media.push({ name: `word/media/${name}`, data });
    relationships.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    if (step.captions !== false) body.push(paragraph(stepCaption(step, n), { style: "Caption" }));
    body.push(imageParagraph(n, `rId${n}`, size));
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body.join("")}<w:sectPr/></w:body></w:document>`;
  const docx = zip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships.join("")}</Relationships>` },
    { name: "word/document.xml", data: document, compress },
    ...media,
  ]);
  const manifest = { version: 1, title: title ?? "Feature demo", steps: steps.map((step, index) => ({ n: index + 1, action: step.action, ...(step.shows ? { shows: step.shows } : {}), ...(step.image ? { image: step.image } : {}) })) };
  return { docx, manifest };
}

/** A 1x1 PNG, for fixtures. */
export const TINY_PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082", "hex");

/** Write <out> and <out>.steps.json. */
export async function writeDemoReport({ out, title, steps, compress }) {
  const { docx, manifest } = await buildDemoReport({ title, steps, compress });
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(out, docx);
  await writeFile(`${out}.steps.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, steps: manifest.steps.length };
}

/**
 * A recorder for a Playwright run: step(page, action, shows) takes one
 * screenshot per navigation or action; finish() writes the report.
 */
export function createDemoRecorder({ dir }) {
  const steps = [];
  return {
    steps,
    async step(page, action, shows) {
      if (!action) throw new Error("Each demo step needs its action (what was done).");
      await mkdir(dir, { recursive: true });
      const image = join(dir, `step-${String(steps.length + 1).padStart(2, "0")}.png`);
      await page.screenshot({ path: image });
      steps.push({ action, shows, image });
      return image;
    },
    async finish({ out, title }) {
      if (!steps.length) throw new Error("The demo recorded no steps.");
      return writeDemoReport({ out, title, steps });
    },
  };
}

async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const stepsPath = flag("steps");
  const out = flag("out");
  if (!stepsPath || !out) throw new Error('Usage: node demo-report.mjs --steps steps.json --out report.docx [--title "..."]');
  const parsed = JSON.parse(await readFile(stepsPath, "utf8"));
  const base = dirname(resolve(stepsPath));
  const steps = (Array.isArray(parsed) ? parsed : parsed.steps ?? []).map((step) => ({ ...step, image: resolve(base, step.image) }));
  const result = await writeDemoReport({ out, title: flag("title") ?? parsed.title, steps });
  process.stdout.write(`wrote ${result.out} with ${result.steps} captioned step(s) and ${result.out}.steps.json\n`);
}

let direct = false;
try {
  direct = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  direct = false;
}
if (direct)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`demo-report: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
