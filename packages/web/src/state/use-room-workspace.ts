import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../adapters/host-protocol/api";
import type { WebProject, WebRoomMessage, WebRoomSummary } from "../types";

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
	sessionId?: string;
	profileId?: string;
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
	selectRoom: (projectId: string, summary: WebRoomSummary) => Promise<void>;
	createRoom: (projectId: string, title: string, member: RoomMemberSelection) => Promise<void>;
	refreshRooms: () => Promise<void>;
	sendRoomMessage: (body: string) => Promise<void>;
}

function roomKey(projectId: string, roomId: string): string {
	return `${projectId}:${roomId}`;
}

function roomSessionId(summary: WebRoomSummary, fallback?: string): string | undefined {
	return fallback ?? summary.room.ownerSessionId;
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
	const roomMessagesRef = useRef<WebRoomMessage[]>([]);
	roomMessagesRef.current = selectedRoomMessages;
	const roomsRequestIdRef = useRef(0);
	const selectionRequestIdRef = useRef(0);

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

	const createRoom = useCallback(
		async (projectId: string, title: string, member: RoomMemberSelection) => {
			if (!sessionId) throw new Error("请先选择一个会话");
			const project = projects.find((candidate) => candidate.id === projectId);
			const owner = project?.sessions.find((session) => session.id === sessionId) ?? project?.sessions[0];
			if (!owner) throw new Error("项目中没有可关联的会话");
			let memberSessionId = member.sessionId;
			if (!memberSessionId && member.profileId) {
				const created = await webApi.createSession(projectId, member.profileId);
				memberSessionId = created.session.id;
				await webApi.release(created.session.id);
				await refreshProjectSessions(projectId);
			}
			if (!memberSessionId || memberSessionId === owner.id) throw new Error("请选择其他 Agent Session");
			const summary = await webApi.createRoom(projectId, owner.id, { title });
			const joined = await webApi.joinRoom(projectId, summary.room.id, memberSessionId);
			setRoomsByProject((current) => ({
				...current,
				[projectId]: [joined, ...(current[projectId] ?? []).filter((candidate) => candidate.room.id !== joined.room.id)],
			}));
			await selectRoom(projectId, joined);
		},
		[projects, refreshProjectSessions, selectRoom, sessionId],
	);

	const sendRoomMessage = useCallback(
		async (body: string) => {
			const projectId = selectedRoomProjectId;
			const room = selectedRoom;
			const senderSessionId = selectedRoomSessionId ?? sessionId;
			if (!projectId || !room || !senderSessionId) throw new Error("请先选择 Room");
			setRoomSending(true);
			try {
				const result = await webApi.sendRoomMessage(projectId, room.room.id, {
					senderSessionId,
					route: "broadcast",
					kind: "message",
					body,
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
		[refreshRooms, selectedRoom, selectedRoomProjectId, selectedRoomSessionId, sessionId, showToast],
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
		selectRoom,
		createRoom,
		refreshRooms,
		sendRoomMessage,
	};
}
