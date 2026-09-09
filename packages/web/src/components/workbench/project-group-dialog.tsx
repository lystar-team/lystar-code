import { FolderPlus, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectGroup, WebProject } from "../../types.ts";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export function ProjectGroupDialog({
	open,
	group,
	onClose,
	onSave,
}: {
	open: boolean;
	group?: ProjectGroup;
	onClose: () => void;
	onSave: (name: string) => Promise<boolean>;
}) {
	const [name, setName] = useState("");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!open) return;
		setName(group?.name ?? "");
		setSaving(false);
	}, [group, open]);
	const submit = async () => {
		const value = name.trim();
		if (!value) return;
		setSaving(true);
		try {
			if (await onSave(value)) onClose();
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog open={open} onOpenChange={(value) => !value && !saving && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{group ? "重命名项目组" : "新建项目组"}</DialogTitle>
					<DialogDescription>
						{group ? "修改项目组名称，组内项目不会改变。" : "把相关项目放在同一组里。"}
					</DialogDescription>
				</DialogHeader>
				<Input
					aria-label="项目组名称"
					autoFocus
					value={name}
					disabled={saving}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void submit();
						}
					}}
					placeholder="输入项目组名称"
				/>
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={saving}>
						取消
					</Button>
					<Button onClick={() => void submit()} disabled={!name.trim() || saving}>
						{saving ? <LoaderCircle className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}
						保存
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function ProjectGroupPickerDialog({
	project,
	groups,
	currentGroupId,
	onClose,
	onSave,
}: {
	project?: WebProject;
	groups: readonly ProjectGroup[];
	currentGroupId?: string;
	onClose: () => void;
	onSave: (groupId?: string) => Promise<boolean>;
}) {
	const [selectedGroupId, setSelectedGroupId] = useState("ungrouped");
	const [saving, setSaving] = useState(false);
	useEffect(() => setSelectedGroupId(currentGroupId ?? "ungrouped"), [currentGroupId, project?.id]);
	const submit = async () => {
		if (!project) return;
		setSaving(true);
		try {
			if (await onSave(selectedGroupId === "ungrouped" ? undefined : selectedGroupId)) onClose();
		} finally {
			setSaving(false);
		}
	};
	return (
		<Dialog open={Boolean(project)} onOpenChange={(value) => !value && !saving && onClose()}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>移动项目</DialogTitle>
					<DialogDescription>{project?.name ?? "项目"} 将移动到选定的项目组。</DialogDescription>
				</DialogHeader>
				<Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder="选择项目组" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="ungrouped">未分组</SelectItem>
						{groups.map((group) => (
							<SelectItem key={group.id} value={group.id}>
								{group.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<DialogFooter>
					<Button variant="outline" onClick={onClose} disabled={saving}>
						取消
					</Button>
					<Button onClick={() => void submit()} disabled={!project || saving}>
						{saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
						移动
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
