import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConversationScrollCache, type ConversationScrollSnapshot } from "./conversation-scroll-cache";

export interface ConversationListHandle {
	scrollToLatest: () => void;
	cancelScroll: () => void;
}

type ConversationScrollOptions = {
	sessionKey: string;
	promptScrollRequest?: number;
};

/** 用户意图与几何位置分开保存；位置补偿只由列表引擎执行。 */
export function useConversationScroll({ sessionKey, promptScrollRequest }: ConversationScrollOptions) {
	const cache = useRef(new ConversationScrollCache()).current;
	const listRef = useRef<ConversationListHandle | null>(null);
	const currentSession = useRef(sessionKey);
	currentSession.current = sessionKey;
	const initialSnapshot = cache.get(sessionKey);
	const [view, setView] = useState({ sessionKey, following: initialSnapshot?.atBottom ?? true, isAtBottom: false });
	if (view.sessionKey !== sessionKey) setView({ sessionKey, following: initialSnapshot?.atBottom ?? true, isAtBottom: false });
	const promptRequest = useRef({ sessionKey, value: promptScrollRequest });

	const handleListRef = useCallback((handle: ConversationListHandle | null) => { listRef.current = handle; }, []);
	const handleSnapshot = useCallback((key: string, snapshot: ConversationScrollSnapshot) => {
		cache.set(key, snapshot);
	}, [cache]);
	const handleAtBottomStateChange = useCallback((key: string, atBottom: boolean) => {
		if (key === currentSession.current) setView((current) => current.isAtBottom === atBottom ? current : { ...current, isAtBottom: atBottom });
	}, []);
	const pauseFollowing = useCallback(() => {
		listRef.current?.cancelScroll();
		setView((current) => current.following ? { ...current, following: false } : current);
	}, []);
	const resumeFollowing = useCallback(() => { setView((current) => current.following ? current : { ...current, following: true }); }, []);
	const handleReturnToBottom = useCallback(() => {
		setView((current) => ({ ...current, following: true }));
		listRef.current?.scrollToLatest();
	}, []);

	useLayoutEffect(() => {
		const previous = promptRequest.current;
		promptRequest.current = { sessionKey, value: promptScrollRequest };
		if (previous.sessionKey !== sessionKey || previous.value === promptScrollRequest) return;
		setView((current) => ({ ...current, following: true }));
		listRef.current?.scrollToLatest();
	}, [promptScrollRequest, sessionKey]);

	return {
		following: view.following, isAtBottom: view.isAtBottom, initialSnapshot,
		handleListRef, handleSnapshot, handleAtBottomStateChange,
		pauseFollowing, resumeFollowing, handleReturnToBottom,
	};
}
