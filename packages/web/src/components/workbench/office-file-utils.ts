export type OfficeFileFormat = "docx" | "xlsx" | "pptx";

function fileName(path: string): string {
	return path.split(/[\\/]/u).at(-1) || "文件";
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

export function officeFormatForPath(path: string): OfficeFileFormat | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase();
	return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : undefined;
}

export function downloadBinaryFile(path: string, data: string, mimeType: string): void {
	const url = URL.createObjectURL(new Blob([base64ToArrayBuffer(data)], { type: mimeType }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName(path);
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
