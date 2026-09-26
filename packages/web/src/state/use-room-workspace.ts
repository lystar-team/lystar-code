import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { webApi } from "../adapters/host-protocol/api";
import { roomAgentMentions } from "../components/workbench/collaboration-session";
import {
	addPendingRoomAgentReplies,
	mergeRoomMessages,
	settlePendingRoomAgentReplies,
	type PendingRoomAgentReply,
} from "../components/workbench/room-message-utils";
import { allocateRoomNickname, readRoomNicknamePool } from "../components/workbench/room-agent-identity";
import type { SubagentConfig, WebProject, WebRoomMessage, WebRoomSummary, WebRoomTask, WebRoomTaskStatus } from "../types";

interface UseRoomWorkspaceOptions {
	active: boolean;
	projects: readonly WebProject[];
	sessionId?: string;
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
	roomTasks: WebRoomTask[];
	roomTasksLoading: boolean;
	roomTasksError?: string;
	createRoomTask: (title: string, description: string) => Promise<void>;
	updateRoomTask: (taskId: string, status: WebRoomTaskStatus, note?: string) => Promise<void>;
	editRoomTask: (taskId: string, changes: { title?: string; description?: string; assigneeSessionId?: string | null }) => Promise<void>;
	commentRoomTask: (taskId: string, body: string) => Promise<void>;
	pendingAgentReplies: PendingRoomAgentReply[];
	roomSending: boolean;
	agentProfiles: SubagentConfig[];
	agentProfilesLoading: boolean;
	roomMentionItems: ReturnType<typeof roomAgentMentions>;
	selectRoom: (projectId: string, summary: WebRoomSummary) => Promise<void>;
	createRoom: (projectId: string, title: string, member: RoomMemberSelection) => Promise<void>;
	inviteRoomMember: (member: RoomMemberSelection) => Promise<void>;
	leaveRoomMember: (sessionId: string) => Promise<void>;
	renameRoomMember: (sessionId: string, nickname: string) => Promise<void>;
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
	active,
	projects,
	sessionId,
	refreshProjectSessions,
	showToast,
}: UseRoomWorkspaceOptions): RoomWorkspaceController {
	const [roomsByProject, setRoomsByProject] = useState<Record<string, WebRoomSummary[]>>({});
	const [roomsLoading, setRoomsLoading] = useState(false);
	const [roomsError, setRoomsError] = useState<string>();
	const [selectedRoomKey, setSelectedRoomKey] = useState<string>();
	const selectedRoomKeyRef = useRef<string>();
	const [selectedRoom, setSelectedRoom] = useState<WebRoomSummary>();
	const [selectedRoomProjectId, setSelectedRoomProjectId] = useState<string>();
	const [selectedRoomSessionId, setSelectedRoomSessionId] = useState<string>();
	const [selectedRoomMessages, setSelectedRoomMessages] = useState<WebRoomMessage[]>([]);
	const [roomMessagesLoading, setRoomMessagesLoading] = useState(false);
	const [roomMessagesError, setRoomMessagesError] = useState<string>();
	const [roomTasks, setRoomTasks] = useState<WebRoomTask[]>([]);
	const [roomTasksLoading, setRoomTasksLoading] = useState(false);
	const [roomTasksError, setRoomTasksError] = useState<string>();
	const [pendingAgentReplies, setPendingAgentReplies] = useState<PendingRoomAgentReply[]>([]);
	const [roomSending, setRoomSending] = useState(false);
	const [agentProfiles, setAgentProfiles] = useState<SubagentConfig[]>([]);
	const [agentProfilesLoading, setAgentProfilesLoading] = useState(false);
	const roomMessagesRef = useRef<WebRoomMessage[]>([]);
	roomMessagesRef.current = selectedRoomMessages;
	const roomsRequestIdRef = useRef(0);
	const roomsInitializedRef = useRef(false);
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
		if (!roomsInitializedRef.current) setRoomsLoading(true);
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
			roomsInitializedRef.current = true;
			const selectedStillExists = Object.values(next)
				.flat()
				.some((summary) => roomKey(selectedRoomProjectId ?? "", summary.room.id) === selectedRoomKey);
			if (!selectedStillExists && selectedRoomKey) {
				setPendingAgentReplies((current) =>
					current.filter((pending) => roomKey(pending.projectId, pending.roomId) !== selectedRoomKey),
				);
				selectedRoomKeyRef.current = undefined;
				roomMessagesRef.current = [];
				setSelectedRoomKey(undefined);
				setSelectedRoom(undefined);
				setSelectedRoomProjectId(undefined);
				setSelectedRoomSessionId(undefined);
				setSelectedRoomMessages([]);
				setRoomTasks([]);
			}
		} catch (error) {
			if (requestId === roomsRequestIdRef.current && !roomsInitializedRef.current) {
				setRoomsError(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (requestId === roomsRequestIdRef.current) setRoomsLoading(false);
		}
	}, [projects, selectedRoomKey, selectedRoomProjectId]);

	useEffect(() => {
		if (active) void refreshRooms();
	}, [active, refreshRooms]);

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
			const key = roomKey(projectId, summary.room.id);
			selectedRoomKeyRef.current = key;
			roomMessagesRef.current = [];
			setSelectedRoomKey(key);
			setSelectedRoom(summary);
			setSelectedRoomProjectId(projectId);
			setSelectedRoomSessionId(senderSessionId);
			setSelectedRoomMessages([]);
			setRoomTasks([]);
			setRoomTasksError(undefined);
			setRoomMessagesError(undefined);
			setRoomMessagesLoading(true);
			try {
				await webApi.joinRoom(projectId, summary.room.id, senderSessionId);
				const response = await webApi.roomMessages(projectId, summary.room.id, senderSessionId, { limit: 100 });
				if (requestId !== selectionRequestIdRef.current) return;
				setSelectedRoom(response.summary);
				roomMessagesRef.current = response.messages;
				setSelectedRoomMessages(response.messages);
				setPendingAgentReplies((current) => settlePendingRoomAgentReplies(current, response.messages));
			} catch (error) {
				if (requestId !== selectionRequestIdRef.current) return;
				const message = error instanceof Error ? error.message : String(error);
				setRoomMessagesError(message);
				showToast(message);
			} finally {
				if (requestId === selectionRequestIdRef.current) setRoomMessagesLoading(false);
			}
		},
		[projects, sessionId, showToast],
	);

	useEffect(() => {
		const projectId = selectedRoomProjectId;
		const roomId = selectedRoom?.room.id;
		const memberSessionId = selectedRoomSessionId;
		if (!projectId || !roomId || !memberSessionId) return;
		const key = roomKey(projectId, roomId);
		let polling = false;
		const poll = async () => {
			if (polling || selectedRoomKeyRef.current !== key) return;
			polling = true;
			try {
				const response = await webApi.roomMessages(projectId, roomId, memberSessionId, {
					afterSeq: roomMessagesRef.current.at(-1)?.seq ?? 0,
					limit: 100,
				});
				if (selectedRoomKeyRef.current !== key) return;
				setRoomMessagesError(undefined);
				setSelectedRoom(response.summary);
				setRoomsByProject((current) => {
					const rooms = current[projectId];
					const currentSummary = rooms?.find((summary) => summary.room.id === roomId);
					if (!rooms || !currentSummary) return current;
					const activeMemberCount = (summary: WebRoomSummary) =>
						summary.members.filter((member) => !member.leftAt).length;
					if (
						currentSummary.latestSeq === response.summary.latestSeq &&
						activeMemberCount(currentSummary) === activeMemberCount(response.summary)
					) {
						return current;
					}
					return {
						...current,
						[projectId]: rooms.map((summary) => (summary.room.id === roomId ? response.summary : summary)),
					};
				});
				setPendingAgentReplies((current) => settlePendingRoomAgentReplies(current, response.messages));
				if (!response.messages.length) return;
				setSelectedRoomMessages((current) => {
					const next = mergeRoomMessages(current, response.messages);
					roomMessagesRef.current = next;
					return next;
				});
			} catch {
				// 轮询失败不打断当前 Room，下一轮继续尝试。
			} finally {
				polling = false;
			}
		};
		const timer = window.setInterval(() => void poll(), 2_000);
		return () => window.clearInterval(timer);
	}, [selectedRoom?.room.id, selectedRoomProjectId, selectedRoomSessionId]);

	const refreshRoomTasks = useCallback(async () => {
		const projectId = selectedRoomProjectId;
		const roomId = selectedRoom?.room.id;
		const memberSessionId = selectedRoomSessionId;
		if (!projectId || !roomId || !memberSessionId) return;
		const key = roomKey(projectId, roomId);
		try {
			const tasks = await webApi.roomTasks(projectId, roomId, memberSessionId);
			if (selectedRoomKeyRef.current !== key) return;
			setRoomTasks(tasks);
			setRoomTasksError(undefined);
		} catch (error) {
			if (selectedRoomKeyRef.current === key) setRoomTasksError(error instanceof Error ? error.message : String(error));
		} finally {
			if (selectedRoomKeyRef.current === key) setRoomTasksLoading(false);
		}
	}, [selectedRoom?.room.id, selectedRoomProjectId, selectedRoomSessionId]);

	useEffect(() => {
		if (!active || !selectedRoom) return;
		setRoomTasksLoading(true);
		void refreshRoomTasks();
		const timer = window.setInterval(() => void refreshRoomTasks(), 3_000);
		return () => window.clearInterval(timer);
	}, [active, refreshRoomTasks, selectedRoom?.room.id]);

	const createRoomTask = useCallback(async (title: string, description: string) => {
		if (!selectedRoomProjectId || !selectedRoom || !selectedRoomSessionId) throw new Error("请先选择 Room");
		await webApi.createRoomTask(selectedRoomProjectId, selectedRoom.room.id, selectedRoomSessionId, title, description);
		await refreshRoomTasks();
	}, [refreshRoomTasks, selectedRoom, selectedRoomProjectId, selectedRoomSessionId]);

	const updateRoomTask = useCallback(async (taskId: string, status: WebRoomTaskStatus, note?: string) => {
		if (!selectedRoomProjectId || !selectedRoom || !selectedRoomSessionId) throw new Error("请先选择 Room");
		await webApi.updateRoomTask(selectedRoomProjectId, selectedRoom.room.id, taskId, selectedRoomSessionId, status, note);
		await refreshRoomTasks();
	}, [refreshRoomTasks, selectedRoom, selectedRoomProjectId, selectedRoomSessionId]);

	const editRoomTask = useCallback(async (taskId: string, changes: { title?: string; description?: string; assigneeSessionId?: string | null }) => {
		if (!selectedRoomProjectId || !selectedRoom || !selectedRoomSessionId) throw new Error("请先选择 Room");
		await webApi.editRoomTask(selectedRoomProjectId, selectedRoom.room.id, taskId, selectedRoomSessionId, changes);
		await refreshRoomTasks();
	}, [refreshRoomTasks, selectedRoom, selectedRoomProjectId, selectedRoomSessionId]);

	const commentRoomTask = useCallback(async (taskId: string, body: string) => {
		if (!selectedRoomProjectId || !selectedRoom || !selectedRoomSessionId) throw new Error("请先选择 Room");
		await webApi.commentRoomTask(selectedRoomProjectId, selectedRoom.room.id, taskId, selectedRoomSessionId, body);
		await refreshRoomTasks();
	}, [refreshRoomTasks, selectedRoom, selectedRoomProjectId, selectedRoomSessionId]);

	const selectedProject = useMemo(
		() => projects.find((project) => project.id === selectedRoomProjectId),
		[projects, selectedRoomProjectId],
	);
	const roomMentionItems = useMemo(() => {
		const agentSessionIds = new Set(
			selectedRoom?.members
				.filter((member) => member.role === "member" && !member.leftAt)
				.map((member) => member.sessionId) ?? [],
		);
		return roomAgentMentions(
			(selectedProject?.sessions ?? []).filter((session) => agentSessionIds.has(session.id)),
			selectedRoom?.members,
		);
	}, [selectedProject?.sessions, selectedRoom?.members]);

	const createRoom = useCallback(
		async (projectId: string, title: string, member: RoomMemberSelection) => {
			if (!sessionId) throw new Error("请先选择一个会话");
			const project = projects.find((candidate) => candidate.id === projectId);
			const owner = project?.sessions.find((session) => session.id === sessionId) ?? project?.sessions[0];
			if (!owner) throw new Error("项目中没有可关联的会话");
			const identity = roomMemberIdentity(member);
			let createdSessionId: string | undefined;
			let joinedRoom = false;
			try {
				const created = await webApi.createSession(projectId, member.profileId, {
					roomAgent: true,
					suppressInfoNotifications: true,
				});
				createdSessionId = created.session.id;
				const summary = await webApi.createRoom(projectId, owner.id, { title });
				const joined = await webApi.joinRoom(projectId, summary.room.id, createdSessionId, identity);
				joinedRoom = true;
				setRoomsByProject((current) => ({
					...current,
					[projectId]: [joined, ...(current[projectId] ?? []).filter((candidate) => candidate.room.id !== joined.room.id)],
				}));
				await refreshProjectSessions(projectId);
				await selectRoom(projectId, joined);
			} catch (error) {
				if (createdSessionId && !joinedRoom) await webApi.release(createdSessionId).catch(() => undefined);
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
			let joinedRoom = false;
			try {
				const created = await webApi.createSession(projectId, member.profileId, {
					roomAgent: true,
					suppressInfoNotifications: true,
				});
				createdSessionId = created.session.id;
				const joined = await webApi.joinRoom(projectId, room.room.id, createdSessionId, identity);
				joinedRoom = true;
				setSelectedRoom(joined);
				setRoomsByProject((current) => ({
					...current,
					[projectId]: (current[projectId] ?? []).map((candidate) =>
						candidate.room.id === joined.room.id ? joined : candidate,
					),
				}));
				await refreshProjectSessions(projectId);
			} catch (error) {
				if (createdSessionId && !joinedRoom) await webApi.release(createdSessionId).catch(() => undefined);
				throw error;
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
			setPendingAgentReplies((current) =>
				current.filter((pending) => pending.roomId !== room.room.id || pending.sessionId !== memberSessionId),
			);
			setRoomsByProject((current) => ({
				...current,
				[projectId]: (current[projectId] ?? []).map((candidate) =>
					candidate.room.id === left.room.id ? left : candidate,
				),
			}));
			if (memberSessionId !== sessionId) await webApi.release(memberSessionId).catch(() => undefined);
		},
		[selectedRoom, selectedRoomProjectId, sessionId],
	);

	const renameRoomMember = useCallback(async (memberSessionId: string, nickname: string) => {
		const projectId = selectedRoomProjectId;
		const room = selectedRoom;
		if (!projectId || !room) throw new Error("请先选择 Room");
		const renamed = await webApi.renameRoomMember(projectId, room.room.id, memberSessionId, nickname);
		if (selectedRoomKeyRef.current === roomKey(projectId, room.room.id)) setSelectedRoom(renamed);
		setRoomsByProject((current) => ({
			...current,
			[projectId]: (current[projectId] ?? []).map((candidate) =>
				candidate.room.id === renamed.room.id ? renamed : candidate,
			),
		}));
	}, [selectedRoom, selectedRoomProjectId]);

	const sendRoomMessage = useCallback(
		async (body: string, attachments?: Array<{ path: string; mimeType: string; filename: string }>) => {
			const projectId = selectedRoomProjectId;
			const room = selectedRoom;
			const senderSessionId = selectedRoomSessionId ?? sessionId;
			if (!projectId || !room || !senderSessionId) throw new Error("请先选择 Room");
			const key = roomKey(projectId, room.room.id);
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
				setPendingAgentReplies((current) =>
					addPendingRoomAgentReplies(
						current,
						projectId,
						result.message,
						roomMessagesRef.current,
						result.errors.map((error) => error.sessionId),
					),
				);
				setRoomsByProject((current) => {
					const rooms = current[projectId];
					if (!rooms) return current;
					return {
						...current,
						[projectId]: rooms.map((summary) =>
							summary.room.id === room.room.id
								? {
									...summary,
									latestSeq: Math.max(summary.latestSeq, result.message.seq),
									room: { ...summary.room, updatedAt: result.message.createdAt },
								}
								: summary,
						),
					};
				});
				if (selectedRoomKeyRef.current === key) {
					setSelectedRoomMessages((current) => {
						const next = mergeRoomMessages(current, [result.message]);
						roomMessagesRef.current = next;
						return next;
					});
					setSelectedRoom((current) =>
						current?.room.id === room.room.id
							? {
								...current,
								latestSeq: Math.max(current.latestSeq, result.message.seq),
								room: { ...current.room, updatedAt: result.message.createdAt },
							}
							: current,
					);
				}
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
		roomTasks,
		roomTasksLoading,
		roomTasksError,
		createRoomTask,
		updateRoomTask,
		editRoomTask,
		commentRoomTask,
		pendingAgentReplies,
		roomSending,
		agentProfiles,
		agentProfilesLoading,
		roomMentionItems,
		selectRoom,
		createRoom,
		inviteRoomMember,
		leaveRoomMember,
		renameRoomMember,
		refreshRooms,
		sendRoomMessage,
	};
}
