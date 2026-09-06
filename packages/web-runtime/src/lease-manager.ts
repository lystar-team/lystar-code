import { randomUUID } from "node:crypto";

export interface ControlLease {
	leaseId: string;
	leaseGeneration: number;
	sessionPath: string;
	clientInstanceId: string;
	createdAt: number;
	updatedAt: number;
}

export class SessionControlLockedError extends Error {
	readonly code = "session_control_locked" as const;
	readonly retryable = true as const;
	readonly sessionPath: string;

	constructor(sessionPath: string) {
		super(`Session is controlled by another Web client: ${sessionPath}`);
		this.name = "SessionControlLockedError";
		this.sessionPath = sessionPath;
	}
}

export class InvalidSessionLeaseError extends Error {
	readonly code = "invalid_session_lease" as const;
	readonly retryable = false as const;

	constructor() {
		super("Session control lease is missing or no longer valid");
		this.name = "InvalidSessionLeaseError";
	}
}

/**
 * Session leases identify attached clients. They are intentionally independent:
 * one Session runtime serializes commands, while multiple UI clients may observe
 * and submit commands at the same time.
 */
export class LeaseManager {
	private readonly leases = new Map<string, Map<string, ControlLease>>();
	private readonly generations = new Map<string, number>();

	acquire(sessionPath: string, clientInstanceId: string): ControlLease {
		const sessionLeases = this.leases.get(sessionPath) ?? new Map<string, ControlLease>();
		const leaseGeneration = (this.generations.get(sessionPath) ?? 0) + 1;
		this.generations.set(sessionPath, leaseGeneration);
		const now = Date.now();
		const lease: ControlLease = {
			leaseId: randomUUID(),
			leaseGeneration,
			sessionPath,
			clientInstanceId,
			createdAt: now,
			updatedAt: now,
		};
		sessionLeases.set(clientInstanceId, lease);
		this.leases.set(sessionPath, sessionLeases);
		return lease;
	}

	assert(sessionPath: string, leaseId: string, clientInstanceId?: string): ControlLease {
		const sessionLeases = this.leases.get(sessionPath);
		const lease = clientInstanceId ? sessionLeases?.get(clientInstanceId) : this.findById(sessionLeases, leaseId);
		if (!lease || lease.leaseId !== leaseId || (clientInstanceId && lease.clientInstanceId !== clientInstanceId)) {
			throw new InvalidSessionLeaseError();
		}
		lease.updatedAt = Date.now();
		return lease;
	}

	release(sessionPath: string, leaseId: string): boolean {
		const sessionLeases = this.leases.get(sessionPath);
		if (!sessionLeases) return false;
		const lease = this.findById(sessionLeases, leaseId);
		if (!lease) return false;
		sessionLeases.delete(lease.clientInstanceId);
		if (sessionLeases.size === 0) this.leases.delete(sessionPath);
		return true;
	}

	releaseClient(clientInstanceId: string): string[] {
		const released: string[] = [];
		for (const [sessionPath, sessionLeases] of this.leases) {
			if (!sessionLeases.delete(clientInstanceId)) continue;
			released.push(sessionPath);
			if (sessionLeases.size === 0) this.leases.delete(sessionPath);
		}
		return released;
	}

	move(sessionPath: string, nextSessionPath: string, leaseId: string): ControlLease {
		const lease = this.assert(sessionPath, leaseId);
		const currentLeases = this.leases.get(sessionPath);
		currentLeases?.delete(lease.clientInstanceId);
		if (currentLeases?.size === 0) this.leases.delete(sessionPath);

		const nextLeases = this.leases.get(nextSessionPath) ?? new Map<string, ControlLease>();
		const leaseGeneration = (this.generations.get(nextSessionPath) ?? 0) + 1;
		this.generations.set(nextSessionPath, leaseGeneration);
		lease.sessionPath = nextSessionPath;
		lease.leaseGeneration = leaseGeneration;
		lease.updatedAt = Date.now();
		nextLeases.set(lease.clientInstanceId, lease);
		this.leases.set(nextSessionPath, nextLeases);
		return lease;
	}

	get(sessionPath: string, clientInstanceId?: string): ControlLease | undefined {
		const sessionLeases = this.leases.get(sessionPath);
		return clientInstanceId ? sessionLeases?.get(clientInstanceId) : sessionLeases?.values().next().value;
	}

	has(sessionPath: string): boolean {
		return (this.leases.get(sessionPath)?.size ?? 0) > 0;
	}

	count(sessionPath: string): number {
		return this.leases.get(sessionPath)?.size ?? 0;
	}

	private findById(sessionLeases: Map<string, ControlLease> | undefined, leaseId: string): ControlLease | undefined {
		if (!sessionLeases) return undefined;
		for (const lease of sessionLeases.values()) if (lease.leaseId === leaseId) return lease;
		return undefined;
	}
}
