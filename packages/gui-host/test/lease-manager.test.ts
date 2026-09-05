import { describe, expect, it } from "vitest";
import { InvalidSessionLeaseError, LeaseManager } from "../src/lease-manager.ts";

describe("LeaseManager", () => {
	describe("supports multiple attached clients", () => {
		it("keeps an independent lease for each client and validates by client", () => {
			const leases = new LeaseManager();
			const first = leases.acquire("/tmp/session.jsonl", "client-a");
			const renewed = leases.acquire("/tmp/session.jsonl", "client-a");
			const second = leases.acquire("/tmp/session.jsonl", "client-b");

			expect(renewed.leaseGeneration).toBe(first.leaseGeneration + 1);
			expect(second.leaseGeneration).toBe(renewed.leaseGeneration + 1);
			expect(() => leases.assert("/tmp/session.jsonl", first.leaseId, "client-a")).toThrow(InvalidSessionLeaseError);
			expect(leases.assert("/tmp/session.jsonl", renewed.leaseId, "client-a")).toBe(renewed);
			expect(leases.assert("/tmp/session.jsonl", second.leaseId, "client-b")).toBe(second);
			expect(leases.count("/tmp/session.jsonl")).toBe(2);
		});

		it("releases one client without detaching the remaining client", () => {
			const leases = new LeaseManager();
			const first = leases.acquire("/tmp/session.jsonl", "client-a");
			const second = leases.acquire("/tmp/session.jsonl", "client-b");

			expect(leases.release("/tmp/session.jsonl", first.leaseId)).toBe(true);
			expect(() => leases.assert("/tmp/session.jsonl", first.leaseId, "client-a")).toThrow(InvalidSessionLeaseError);
			expect(leases.assert("/tmp/session.jsonl", second.leaseId, "client-b")).toBe(second);
			expect(leases.has("/tmp/session.jsonl")).toBe(true);
		});
	});
});
