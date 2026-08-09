import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PhotonImage, resize as resizeImage, SamplingFilter } from "@silvia-odwyer/photon-node";

const [sourceArg, pngArg, icoArg] = process.argv.slice(2);
if (!sourceArg || !pngArg || !icoArg) {
	throw new Error("Usage: node scripts/generate-windows-icon.mjs <source.png> <output.png> <output.ico>");
}

const sourcePath = resolve(sourceArg);
const pngPath = resolve(pngArg);
const icoPath = resolve(icoArg);
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const source = PhotonImage.new_from_byteslice(readFileSync(sourcePath));
const images = sizes.map((size) => {
	const resized = resizeImage(source, size, size, SamplingFilter.Lanczos3);
	const bytes = Buffer.from(resized.get_bytes());
	resized.free();
	return { size, bytes };
});
source.free();

mkdirSync(dirname(pngPath), { recursive: true });
writeFileSync(pngPath, readFileSync(sourcePath));

const headerSize = 6 + images.length * 16;
let imageOffset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
for (let index = 0; index < images.length; index++) {
	const image = images[index];
	const entryOffset = 6 + index * 16;
	header.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset);
	header.writeUInt8(image.size === 256 ? 0 : image.size, entryOffset + 1);
	header.writeUInt8(0, entryOffset + 2);
	header.writeUInt8(0, entryOffset + 3);
	header.writeUInt16LE(1, entryOffset + 4);
	header.writeUInt16LE(32, entryOffset + 6);
	header.writeUInt32LE(image.bytes.length, entryOffset + 8);
	header.writeUInt32LE(imageOffset, entryOffset + 12);
	imageOffset += image.bytes.length;
}
writeFileSync(icoPath, Buffer.concat([header, ...images.map((image) => image.bytes)]));