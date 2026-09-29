import { VirtualizedConversationTranscript, type VirtualizedConversationTranscriptProps } from "./virtualized-transcript";

type PrependAnchoredTranscriptProps<T> = VirtualizedConversationTranscriptProps<T>;

/** Virtuoso owns prepend compensation through firstItemIndex. */
export function PrependAnchoredConversationTranscript<T>({
	sessionKey,
	...props
}: PrependAnchoredTranscriptProps<T>) {
	return <VirtualizedConversationTranscript {...props} sessionKey={sessionKey} />;
}
