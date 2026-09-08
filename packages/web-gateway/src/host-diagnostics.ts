import { statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, networkInterfaces, totalmem, uptime } from "node:os";

export interface CpuSnapshot {
	idle: number;
	total: number;
}

export interface DiskUsage {
	path: string;
	available: boolean;
	totalBytes?: number;
	freeBytes?: number;
	usedBytes?: number;
	usedPercent?: number;
}

export function readCpuSnapshot(): CpuSnapshot {
	const processors = cpus();
	return processors.reduce(
		(snapshot, processor) => {
			const idle = processor.times.idle;
			const total = Object.values(processor.times).reduce((sum, value) => sum + value, 0);
			return { idle: snapshot.idle + idle, total: snapshot.total + total };
		},
		{ idle: 0, total: 0 },
	);
}

export function calculateCpuUsage(previous: CpuSnapshot | undefined, current: CpuSnapshot): number | undefined {
	if (!previous) return undefined;
	const totalDelta = current.total - previous.total;
	const idleDelta = current.idle - previous.idle;
	if (totalDelta <= 0) return undefined;
	return Math.round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) * 10) / 10;
}

export function hostNetworkAddresses(): string[] {
	const addresses = Object.values(networkInterfaces())
		.flatMap((entries) => entries ?? [])
		.filter((entry) => !entry.internal)
		.map((entry) => entry.address)
		.filter((address, index, all) => all.indexOf(address) === index);
	return addresses;
}

export function hostMemory(): {
	totalBytes: number;
	freeBytes: number;
	usedBytes: number;
	usedPercent: number;
} {
	const totalBytes = totalmem();
	const freeBytes = freemem();
	const usedBytes = Math.max(0, totalBytes - freeBytes);
	return {
		totalBytes,
		freeBytes,
		usedBytes,
		usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
	};
}

export function hostCpu(usagePercent: number | undefined): {
	cores: number;
	usagePercent?: number;
	loadAverage: number[];
} {
	const cores = cpus().length;
	return {
		cores,
		...(usagePercent === undefined ? {} : { usagePercent }),
		loadAverage: loadavg().map((value) => Math.round(value * 100) / 100),
	};
}

export async function diskUsage(path: string): Promise<DiskUsage> {
	try {
		const stats = await statfs(path);
		const totalBytes = stats.blocks * stats.bsize;
		const freeBytes = stats.bavail * stats.bsize;
		const usedBytes = Math.max(0, totalBytes - freeBytes);
		return {
			path,
			available: true,
			totalBytes,
			freeBytes,
			usedBytes,
			usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
		};
	} catch {
		return { path, available: false };
	}
}

export function hostUptimeSeconds(): number {
	return Math.floor(uptime());
}
