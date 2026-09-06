import type { ReactNode } from "react";
import { Card, CardContent } from "../../ui/card";

export function SettingSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="grid gap-3">
			<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
			{children}
		</section>
	);
}

export function StatText({ label, value }: { label: string; value: string }) {
	return (
		<Card className="shadow-none">
			<CardContent className="p-3">
				<p className="text-xs text-muted-foreground">{label}</p>
				<p className="mt-1 truncate font-mono text-sm">{value}</p>
			</CardContent>
		</Card>
	);
}
