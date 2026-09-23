import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../adapters/host-protocol/api";
import { roomAgentMentions } from "../components/workbench/collaboration-session";
import { allocateRoomNickname, readRoomNicknamePool } from "../components/workbench/room-agent-identity";
import type { SubagentConfig, WebProject, WebRoomMessage, WebRoomSummary } from "../types";

interface UseRoomWorkspaceOptions {
	projects: readonly WebProject[];
	sessionId?: string;
	onSelectSession: (sessionId: string) => Promise<void>;
	refreshProjectSessions: (projectId: string) => Promise<void>;
	showToast: (message: string) => void;
}

export interface RoomProjectList {
	project: WebProject;
	rooms: WebRoomSummary[];
}

export interface RoomMemberSelection {
	profileId: string;
	profileName: string;
	profileIcon?: string;
}

export interface RoomWorkspaceController {
	roomProjects: RoomProjectList[];
	roomsLoading: boolean;
	roomsError?: string;
	selectedRoom?: WebRoomSummary;
	selectedRoomProjectId?: string;
	selectedRoomMessages: WebRoomMessage[];
	roomMessagesLoading: boolean;
	roomMessagesError?: string;
	roomSending: boolean;
	agentProfiles: SubagentConfig[];
	agentProfilesLoading: boolean;
	roomMentionItems: ReturnType<typeof roomAgentMentions>;
	selectRoom: (projectId: string, summary: WebRoomSummary) => Promise<void>;
	createRoom: (projectId: string, title: string, member: RoomMemberSelection) => Promise<void>;
	inviteRoomMember: (member: RoomMemberSelection) => Promise<void>;
	leaveRoomMember: (sessionId: string) => Promise<void>;
	refreshRooms: () => Promise<void>;
	sendRoomMessage: (body: string, attachments?: Array<{ path: string; mimeType: string; filename: string }>) => Promise<void>;
}

function roomKey(projectId: string, roomId: string): string {
	return `${projectId}:${roomId}`;
}

function roomSessionId(summary: WebRoomSummary, fallback?: string): string | undefined {
	return fallback ?? summary.room.ownerSessionId;
}

function roomMemberIdentity(member: RoomMemberSelection, room?: WebRoomSummary): {
	nickname: string;
	profileId: string;
	profileName: string;
	profileIcon?: string;
} {
	const nickname = allocateRoomNickname(
		room?.members.filter((candidate) => !candidate.leftAt) ?? [],
		readRoomNicknamePool(),
	);
	if (!nickname) throw new Error("昵称库没有可用昵称，请先在设置中补充昵称");
	return {
		nickname,
		profileId: member.profileId,
		profileName: member.profileName,
		...(member.profileIcon ? { profileIcon: member.profileIcon } : {}),
	};
}

export function useRoomWorkspace({
	projects,
	sessionId,
	onSelectSession,
	refreshProjectSessions,
	showToast,
}: UseRoomWorkspaceOptions): RoomWorkspaceController {
	const [roomsByProject, setRoomsByProject] = useState<Record<string, WebRoomSummary[]>>({});
	const [roomsLoading, setRoomsLoading] = useState(false);
	const [roomsError, setRoomsError] = useState<string>();
	const [selectedRoomKey, setSelectedRoomKey] = useState<string>();
	const [selectedRoom, setSelectedRoom] = useState<WebRoomSummary>();
	const [selectedRoomProjectId, setSelectedRoomProjectId] = useState<string>();
	const [selectedRoomSessionId, setSelectedRoomSessionId] = useState<string>();
	const [selectedRoomMessages, setSelectedRoomMessages] = useState<WebRoomMessage[]>([]);
	const [roomMessagesLoading, setRoomMessagesLoading] = useState(false);
	const [roomMessagesError, setRoomMessagesError] = useState<string>();
	const [roomSending, setRoomSending] = useState(false);
	const [agentProfiles, setAgentProfiles] = useState<SubagentConfig[]>([]);
	const [agentProfilesLoading, setAgentProfilesLoading] = useState(false);
	const roomMessagesRef = useRef<WebRoomMessage[]>([]);
	roomMessagesRef.current = selectedRoomMessages;
	const roomsRequestIdRef = useRef(0);
	const selectionRequestIdRef = useRef(0);
	const profileRequestIdRef = useRef(0);

	const roomProjects = useMemo(
		() =>
			projects
				.filter((project) => !project.archived)
				.map((project) => ({ project, rooms: roomsByProject[project.id] ?? [] }))
				.filter(({ rooms }) => rooms.length > 0),
		[projects, roomsByProject],
	);
	const refreshRooms = useCallback(async () => {
		const requestId = ++roomsRequestIdRef.current;
		setRoomsLoading(true);
		try {
			const entries = await Promise.all(
				projects
					.filter((project) => !project.archived)
					.map(async (project): Promise<[string, WebRoomSummary[]]> => [project.id, await webApi.projectRooms(project.id)]),
			);
			if (requestId !== roomsRequestIdRef.current) return;
			const next = Object.fromEntries(entries);
			setRoomsError(undefined);
			setRoomsByProject(next);
			const selectedStillExists = Object.values(next)
				.flat()
				.some((summary) => roomKey(selectedRoomProjectId ?? "", summary.room.id) === selectedRoomKey);
			if (!selectedStillExists && selectedRoomKey) {
				setSelectedRoomKey(undefined);
				setSelectedRoom(undefined);
				setSelectedRoomProjectId(undefined);
				setSelectedRoomSessionId(undefined);
				setSelectedRoomMessages([]);
			}
		} catch (error) {
			if (requestId === roomsRequestIdRef.current) setRoomsError(error instanceof Error ? error.message : String(error));
		} finally {
			if (requestId === roomsRequestIdRef.current) setRoomsLoading(false);
		}
	}, [projects, selectedRoomKey, selectedRoomProjectId]);

	useEffect(() => {
		void refreshRooms();
	}, [refreshRooms]);

	useEffect(() => {
		const projectId = selectedRoomProjectId;
		if (!projectId) {
			setAgentProfiles([]);
			return;
		}
		const requestId = ++profileRequestIdRef.current;
		setAgentProfilesLoading(true);
		void webApi
			.subagentConfigs(projectId)
			.then((response) => {
				if (requestId === profileRequestIdRef.current) setAgentProfiles(response.subagents);
			})
			.catch(() => {
				if (requestId === profileRequestIdRef.current) setAgentProfiles([]);
			})
			.finally(() => {
				if (requestId === profileRequestIdRef.current) setAgentProfilesLoading(false);
			});
	}, [selectedRoomProjectId]);

	const selectRoom = useCallback(
		async (projectId: string, summary: WebRoomSummary) => {
			const requestId = ++selectionRequestIdRef.current;
			const project = projects.find((candidate) => candidate.id === projectId);
			const senderSessionId =
				project?.sessions.find((session) => session.id === summary.room.ownerSessionId)?.id ??
				project?.sessions.find((session) => session.id === sessionId)?.id ??
				project?.sessions[0]?.id ??
				roomSessionId(summary, sessionId);
			if (!senderSessionId) {
				showToast("Room 没有关联可用会话");
				return;
			}
			setSelectedRoomKey(roomKey(projectId, summary.room.id));
			setSelectedRoom(summary);
			setSelectedRoomProjectId(projectId);
			setSelectedRoomSessionId(senderSessionId);
			setSelectedRoomMessages([]);
			setRoomMessagesError(undefined);
			setRoomMessagesLoading(true);
			try {
				if (senderSessionId !== sessionId) await onSelectSession(senderSessionId);
				await webApi.joinRoom(projectId, summary.room.id, senderSessionId);
				const response = await webApi.roomMessages(projectId, summary.room.id, senderSessionId, { limit: 100 });
				if (requestId !== selectionRequestIdRef.current) return;
				setSelectedRoom(response.summary);
				setSelectedRoomMessages(response.messages);
			} catch (error) {
				if (requestId !== selectionRequestIdRef.current) return;
				const message = error instanceof Error ? error.message : String(error);
				setRoomMessagesError(message);
				showToast(message);
			} finally {
				if (requestId === selectionRequestIdRef.current) setRoomMessagesLoading(false);
			}
		},
		[onSelectSession, projects, sessionId, showToast],
	);

	useEffect(() => {
		const projectId = selectedRoomProjectId;
		const roomId = selectedRoom?.room.id;
		const memberSessionId = selectedRoomSessionId;
		if (!projectId || !roomId || !memberSessionId) return;
		const poll = async () => {
			try {
				const response = await webApi.roomMessages(projectId, roomId, memberSessionId, {
					afterSeq: roomMessagesRef.current.at(-1)?.seq ?? 0,
					limit: 100,
				});
				setRoomMessagesError(undefined);
				setSelectedRoom(response.summary);
				if (!response.messages.length) return;
				setSelectedRoomMessages((current) => {
					const known = new Set(current.map((message) => message.id));
					const next = [...current, ...response.messages.filter((message) => !known.has(message.id))];
					roomMessagesRef.current = next;
					return next;
				});
			} catch {
				// 轮询失败不打断当前 Room，下一轮继续尝试。
			}
		};
		const timer = window.setInterval(() => void poll(), 2_000);
		return () => window.clearInterval(timer);
	}, [selectedRoom?.room.id, selectedRoomProjectId, selectedRoomSessionId]);

	const selectedProject = useMemo(
		() => projects.find((project) => project.id === selectedRoomProjectId),
		[projects, selectedRoomProjectId],
	);
	const roomMentionItems = useMemo(
		() =>
			roomAgentMentions(
				(selectedProject?.sessions ?? []).filter((session) =>
					selectedRoom?.members.some((member) => member.sessionId === session.id && !member.leftAt),
				),
			selectedRoom?.members,
			),
		[selectedProject?.sessions, selectedRoom?.members],
	);

	const createRoom = useCallback(
		async (projectId: string, title: string, member: RoomMemberSelection) => {
			if (!sessionId) throw new Error("请先选择一个会话");
			const project = projects.find((candidate) => candidate.id === projectId);
			const owner = project?.sessions.find((session) => session.id === sessionId) ?? project?.sessions[0];
			if (!owner) throw new Error("项目中没有可关联的会话");
			const identity = roomMemberIdentity(member);
			let createdSessionId: string | undefined;
			try {
				const created = await webApi.createSession(projectId, member.profileId);
				createdSessionId = created.session.id;
				await webApi.release(created.session.id);
				const summary = await webApi.createRoom(projectId, owner.id, { title });
				const joined = await webApi.joinRoom(projectId, summary.room.id, createdSessionId, identity);
				setRoomsByProject((current) => ({
					...current,
					[projectId]: [joined, ...(current[projectId] ?? []).filter((candidate) => candidate.room.id !== joined.room.id)],
				}));
				await refreshProjectSessions(projectId);
				await selectRoom(projectId, joined);
			} catch (error) {
				if (createdSessionId) await webApi.release(createdSessionId).catch(() => undefined);
				throw error;
			}
		},
		[projects, refreshProjectSessions, selectRoom, sessionId],
	);

	const inviteRoomMember = useCallback(
		async (member: RoomMemberSelection) => {
			const projectId = selectedRoomProjectId;
			const room = selectedRoom;
			if (!projectId || !room) throw new Error("请先选择 Room");
			const identity = roomMemberIdentity(member, room);
			let createdSessionId: string | undefined;
			try {
				const created = await webApi.createSession(projectId, member.profileId);
				createdSessionId = created.session.id;
				const joined = await webApi.joinRoom(projectId, room.room.id, createdSessionId, identity);
				setSelectedRoom(joined);
				setRoomsByProject((current) => ({
					...current,
					[projectId]: (current[projectId] ?? []).map((candidate) =>
						candidate.room.id === joined.room.id ? joined : candidate,
					),
				}));
				await refreshProjectSessions(projectId);
			} finally {
				if (createdSessionId) await webApi.release(createdSessionId).catch(() => undefined);
			}
		},
		[refreshProjectSessions, selectedRoom, selectedRoomProjectId],
	);

	const leaveRoomMember = useCallback(
		async (memberSessionId: string) => {
			const projectId = selectedRoomProjectId;
			const room = selectedRoom;
			if (!projectId || !room) throw new Error("请先选择 Room");
			if (memberSessionId === room.room.ownerSessionId) throw new Error("Room Owner 不能退出 Room");
			const left = await webApi.leaveRoom(projectId, room.room.id, memberSessionId);
			setSelectedRoom(left);
			setRoomsByProject((current) => ({
				...current,
				[projectId]: (current[projectId] ?? []).map((candidate) =>
					candidate.room.id === left.room.id ? left : candidate,
				),
			}));
		},
		[selectedRoom, selectedRoomProjectId],
	);

	const sendRoomMessage = useCallback(
		async (body: string, attachments?: Array<{ path: string; mimeType: string; filename: string }>) => {
			const projectId = selectedRoomProjectId;
			const room = selectedRoom;
			const senderSessionId = selectedRoomSessionId ?? sessionId;
			if (!projectId || !room || !senderSessionId) throw new Error("请先选择 Room");
			const tokens = new Set(body.split(/[\s,，。；;!?！？、()[\]{}<>]+/u).filter(Boolean));
			const targetSessionIds = roomMentionItems
				.filter(({ item }) => tokens.has(item.value))
				.map(({ sessionId: targetSessionId }) => targetSessionId);
			setRoomSending(true);
			try {
				const result = await webApi.sendRoomMessage(projectId, room.room.id, {
					senderSessionId,
					senderType: "user",
					route: targetSessionIds.length === 1 ? "direct" : "broadcast",
					...(targetSessionIds.length ? { targetSessionIds } : {}),
					kind: "message",
					body,
					...(attachments?.length ? { attachments } : {}),
				});
				setSelectedRoomMessages((current) => {
					if (current.some((message) => message.id === result.message.id)) return current;
					return [...current, result.message];
				});
				setSelectedRoom((current) =>
					current
						? {
							...current,
							latestSeq: Math.max(current.latestSeq, result.message.seq),
							room: { ...current.room, updatedAt: result.message.createdAt },
						}
						: current,
				);
				if (result.errors.length) {
					showToast(`部分 Agent 未响应：${result.errors.map((error) => error.message).join("；")}`);
				}
				void refreshRooms();
			} finally {
				setRoomSending(false);
			}
		},
		[refreshRooms, roomMentionItems, selectedRoom, selectedRoomProjectId, selectedRoomSessionId, sessionId, showToast],
	);

	return {
		roomProjects,
		roomsLoading,
		roomsError,
		selectedRoom,
		selectedRoomProjectId,
		selectedRoomMessages,
		roomMessagesLoading,
		roomMessagesError,
		roomSending,
		agentProfiles,
		agentProfilesLoading,
		roomMentionItems,
		selectRoom,
		createRoom,
		inviteRoomMember,
		leaveRoomMember,
		refreshRooms,
		sendRoomMessage,
	};
}
