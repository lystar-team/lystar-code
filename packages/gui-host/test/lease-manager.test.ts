import { describe, expect, it } from "vitest";
import { InvalidSessionLeaseError, LeaseManager, SessionControlLockedError } from "../src/lease-manager.ts";

describe("LeaseManager", () => {
	it("keeps one controlling client per session", () => {
		const leases = new LeaseManager();
		const first = leases.acquire("/tmp/session.jsonl", "client-a");
		const renewed = leases.acquire("/tmp/session.jsonl", "client-a");

		expect(renewed.leaseGeneration).toBe(first.leaseGeneration + 1);
		expect(() => leases.acquire("/tmp/session.jsonl", "client-b")).toThrow(SessionControlLockedError);
		expect(() => leases.assert("/tmp/session.jsonl", first.leaseId, "client-a")).toThrow(InvalidSessionLeaseError);
		expect(leases.assert("/tmp/session.jsonl", renewed.leaseId, "client-a")).toBe(renewed);
	});
});
