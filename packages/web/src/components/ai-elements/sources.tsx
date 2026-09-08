"use client";

import { ChevronDownIcon, ExternalLinkIcon, Globe2Icon } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";

export type SourcesProps = ComponentProps<"div">;

export const Sources = ({ className, ...props }: SourcesProps) => (
	<Collapsible className={cn("not-prose mb-4 text-xs text-primary", className)} {...props} />
);

export type SourcesTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
	count: number;
};

export const SourcesTrigger = ({ className, count, children, ...props }: SourcesTriggerProps) => (
	<CollapsibleTrigger className={cn("flex items-center gap-2", className)} {...props}>
		{children ?? (
			<>
				<p className="font-medium">已使用 {count} 个来源</p>
				<ChevronDownIcon className="size-4" />
			</>
		)}
	</CollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof CollapsibleContent>;

export const SourcesContent = ({ className, ...props }: SourcesContentProps) => (
	<CollapsibleContent
		className={cn(
			"mt-3 flex w-full max-w-xl flex-col gap-1.5",
			"outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
			className,
		)}
		{...props}
	/>
);

function sourceDisplayName(href?: string, title?: string): string {
	if (title?.trim()) return title.trim();
	if (!href) return "未知来源";
	try {
		return new URL(href).hostname;
	} catch {
		return href;
	}
}

function sourceFaviconUrl(href?: string): string | undefined {
	if (!href) return undefined;
	try {
		const url = new URL(href);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`;
	} catch {
		return undefined;
	}
}

export function SourceFavicon({ href, className }: { href?: string; className?: string }) {
	const [failed, setFailed] = useState(false);
	const src = sourceFaviconUrl(href);
	if (!src || failed) return <Globe2Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
	return (
		<img
			alt=""
			aria-hidden="true"
			className={cn("size-4 shrink-0 rounded-sm object-contain", className)}
			onError={() => setFailed(true)}
			src={src}
		/>
	);
}

export type SourceProps = ComponentProps<"a">;

export const Source = ({ href, title, children, className, ...props }: SourceProps) => (
	<a
		className={cn(
			"group/source flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 text-left text-foreground transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			className,
		)}
		href={href}
		rel="noreferrer"
		target="_blank"
		{...props}
	>
		<SourceFavicon href={href} />
		{children ?? (
			<span className="min-w-0 flex-1 truncate text-xs font-medium" title={sourceDisplayName(href, title)}>
				{sourceDisplayName(href, title)}
			</span>
		)}
		<ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover/source:text-foreground" />
	</a>
);
