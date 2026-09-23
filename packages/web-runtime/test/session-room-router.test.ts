import { describe, expect, it } from "vitest";
import { resolveSessionRoomTargets } from "../src/session-room-router.ts";

const members = [
	{
		roomId: "room-1",
		sessionId: "owner",
		role: "owner" as const,
		joinedAt: "2026-09-21T00:00:00.000Z",
		lastReadSeq: 0,
	},
	{
		roomId: "room-1",
		sessionId: "first",
		role: "member" as const,
		joinedAt: "2026-09-21T00:01:00.000Z",
		lastReadSeq: 0,
	},
	{
		roomId: "room-1",
		sessionId: "second",
		role: "member" as const,
		joinedAt: "2026-09-21T00:02:00.000Z",
		lastReadSeq: 0,
	},
];

describe("session room routing", () => {
	it("routes direct messages to one active member", () => {
		expect(
			resolveSessionRoomTargets({
				route: "direct",
				senderSessionId: "owner",
				targetSessionIds: ["second"],
				members,
			}),
		).toEqual(["second"]);
	});

	it("broadcasts in stable member order without sending back to the sender", () => {
		expect(
			resolveSessionRoomTargets({
				route: "broadcast",
				senderSessionId: "owner",
				members,
			}),
		).toEqual(["first", "second"]);
	});

	it("lets a user message reach every active Agent, including the current session", () => {
		expect(
			resolveSessionRoomTargets({
				route: "broadcast",
				senderSessionId: "owner",
				senderType: "user",
				members,
			}),
		).toEqual(["owner", "first", "second"]);
	});

	it("supports user-selected direct and multi-Agent targets", () => {
		expect(
			resolveSessionRoomTargets({
				route: "direct",
				senderSessionId: "owner",
				senderType: "user",
				targetSessionIds: ["owner"],
				members,
			}),
		).toEqual(["owner"]);
		expect(
			resolveSessionRoomTargets({
				route: "broadcast",
				senderSessionId: "owner",
				senderType: "user",
				targetSessionIds: ["second", "first"],
				members,
			}),
		).toEqual(["first", "second"]);
	});

	it("selects the available member for one-of-us routing", () => {
		expect(
			resolveSessionRoomTargets({
				route: "one_of_us",
				senderSessionId: "owner",
				members,
				availability: new Map([
					["first", "running"],
					["second", "idle"],
				]),
			}),
		).toEqual(["second"]);
	});

	it("rejects direct messages without an active target", () => {
		expect(() =>
			resolveSessionRoomTargets({
				route: "direct",
				senderSessionId: "owner",
				members,
			}),
		).toThrowError(/必须指定一个目标/);
	});
});
