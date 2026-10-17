import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { DEFAULT_ROOM_NICKNAMES, readRoomNicknamePool, saveRoomNicknamePool } from "../room-agent-identity";

export function AgentNicknameDialog({ onClose }: { onClose: () => void }) {
	const [nicknames, setNicknames] = useState(() => readRoomNicknamePool());
	const [input, setInput] = useState("");
	const add = () => {
		const nickname = input.trim();
		if (!nickname || nicknames.includes(nickname)) return;
		setNicknames((current) => [...current, nickname]);
		setInput("");
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>协作昵称</DialogTitle>
					<DialogDescription>成员加入协作时，从未占用的昵称中分配。保存后对新加入的成员生效。</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 overflow-y-auto">
					<div className="mb-4 flex flex-wrap gap-2">
						{nicknames.map((name) => (
							<span
								className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted pl-3 text-sm"
								key={name}
							>
								<span className="min-w-0 break-all">{name}</span>
								<button
									type="button"
									aria-label={`移除昵称 ${name}`}
									className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => setNicknames((current) => current.filter((item) => item !== name))}
								>
									<X className="size-3.5" aria-hidden />
								</button>
							</span>
						))}
					</div>
					<form
						className="flex gap-2"
						onSubmit={(event) => {
							event.preventDefault();
							add();
						}}
					>
						<Input
							className="h-10"
							aria-label="添加智能体协作昵称"
							placeholder="输入昵称后按 Enter 添加"
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault();
							}}
						/>
						<Button variant="outline" type="submit" disabled={!input.trim() || nicknames.includes(input.trim())}>
							添加
						</Button>
					</form>
					<p className="mt-3 text-xs text-muted-foreground">{nicknames.length} 个昵称</p>
				</div>
				<DialogFooter className="flex-wrap gap-2">
					<Button className="sm:mr-auto" variant="ghost" onClick={() => setNicknames([...DEFAULT_ROOM_NICKNAMES])}>
						恢复默认
					</Button>
					<Button variant="outline" onClick={onClose}>
						取消
					</Button>
					<Button
						onClick={() => {
							const nickname = input.trim();
							saveRoomNicknamePool(
								nickname && !nicknames.includes(nickname) ? [...nicknames, nickname] : nicknames,
							);
							onClose();
						}}
					>
						保存昵称库
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
