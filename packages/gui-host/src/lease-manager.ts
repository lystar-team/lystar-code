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
		super(`Session is controlled by another GUI client: ${sessionPath}`);
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

export class LeaseManager {
	private readonly leases = new Map<string, ControlLease>();
	private readonly generations = new Map<string, number>();

	acquire(sessionPath: string, clientInstanceId: string): ControlLease {
		const current = this.leases.get(sessionPath);
		if (current && current.clientInstanceId !== clientInstanceId) throw new SessionControlLockedError(sessionPath);
		const leaseGeneration = (this.generations.get(sessionPath) ?? 0) + 1;
		this.generations.set(sessionPath, leaseGeneration);
		const now = Date.now();
		const lease = {
			leaseId: randomUUID(),
			leaseGeneration,
			sessionPath,
			clientInstanceId,
			createdAt: now,
			updatedAt: now,
		};
		this.leases.set(sessionPath, lease);
		return lease;
	}

	assert(sessionPath: string, leaseId: string, clientInstanceId?: string): ControlLease {
		const lease = this.leases.get(sessionPath);
		if (!lease || lease.leaseId !== leaseId || (clientInstanceId && lease.clientInstanceId !== clientInstanceId)) {
			throw new InvalidSessionLeaseError();
		}
		lease.updatedAt = Date.now();
		return lease;
	}

	release(sessionPath: string, leaseId: string): boolean {
		const lease = this.leases.get(sessionPath);
		if (!lease || lease.leaseId !== leaseId) return false;
		this.leases.delete(sessionPath);
		return true;
	}

	releaseClient(clientInstanceId: string): string[] {
		const released: string[] = [];
		for (const [sessionPath, lease] of this.leases) {
			if (lease.clientInstanceId !== clientInstanceId) continue;
			this.leases.delete(sessionPath);
			released.push(sessionPath);
		}
		return released;
	}

	move(sessionPath: string, nextSessionPath: string, leaseId: string): ControlLease {
		const lease = this.assert(sessionPath, leaseId);
		if (this.leases.has(nextSessionPath)) throw new SessionControlLockedError(nextSessionPath);
		this.leases.delete(sessionPath);
		lease.sessionPath = nextSessionPath;
		lease.leaseGeneration = (this.generations.get(nextSessionPath) ?? 0) + 1;
		lease.updatedAt = Date.now();
		this.generations.set(nextSessionPath, lease.leaseGeneration);
		this.leases.set(nextSessionPath, lease);
		return lease;
	}

	get(sessionPath: string): ControlLease | undefined {
		return this.leases.get(sessionPath);
	}
}
