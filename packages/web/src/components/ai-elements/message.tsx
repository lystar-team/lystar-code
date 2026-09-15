"use client";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { projectCodeHighlighter } from "@/lib/code-highlighter";
import { isExternalResourceLink, isLocalResourcePath, resolveResourcePath } from "@/lib/resource-path";
import type { UIMessage } from "ai";
import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { Virtuoso } from "react-virtuoso";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, NamedExoticComponent, ReactElement } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { PlainTextCodeBlock } from "./code-block";
import { ResourceImage } from "./resource-preview";
import {
	parseMarkdownIntoBlocks,
	Streamdown,
	defaultRehypePlugins,
	type PluginConfig,
} from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
  tooltipOpen?: boolean;
  onTooltipOpenChange?: (open: boolean) => void;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  tooltipOpen,
  onTooltipOpenChange,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip
          disableHoverableContent
          onOpenChange={onTooltipOpenChange}
          open={tooltipOpen}
        >
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown> &
	Pick<HTMLAttributes<HTMLDivElement>, "id" | "role" | "aria-labelledby"> & {
		onOpenPath?: (path: string) => void;
		projectId?: string;
		basePath?: string;
		virtualize?: boolean;
	};

export const MARKDOWN_VIRTUALIZATION_THRESHOLD = 96 * 1024;

export function shouldVirtualizeMarkdown(content: string): boolean {
	return content.length >= MARKDOWN_VIRTUALIZATION_THRESHOLD;
}

type ResourcePathContextValue = {
	onOpenPath?: (path: string) => void;
	projectId?: string;
	basePath?: string;
};

const ResourcePathContext = createContext<ResourcePathContextValue>({});

const messageRehypePlugins = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize];

function messageRehypePluginsFor(callerPlugins: MessageResponseProps["rehypePlugins"]): NonNullable<MessageResponseProps["rehypePlugins"]> {
	return callerPlugins ?? messageRehypePlugins;
}

const MessageMarkdownImage = ({ src, alt }: ComponentProps<"img">) => {
	const resource = useContext(ResourcePathContext);
	const localPath = src && isLocalResourcePath(src) ? resolveResourcePath(resource.basePath, src) : undefined;
	return src ? (
		<ResourceImage
			{...(localPath ? { path: localPath, projectId: resource.projectId } : { src })}
			alt={alt || "图片"}
			className="my-3 max-w-full"
			onOpenPath={resource.onOpenPath}
		/>
	) : null;
};

function ExternalMessageLink({ href, children }: { href: string; children: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
				onClick={() => setOpen(true)}
				type="button"
			>
				{children}
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>打开外部链接？</DialogTitle>
						<DialogDescription className="break-all">{href}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
						<Button
							onClick={() => {
								window.open(href, "_blank", "noopener,noreferrer");
								setOpen(false);
							}}
						>
							打开链接
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

const MessageMarkdownLink = ({ href, children, ...props }: ComponentProps<"a">) => {
	const resource = useContext(ResourcePathContext);
	const localPath = href && isLocalResourcePath(href) ? resolveResourcePath(resource.basePath, href) : undefined;
	if (localPath && resource.onOpenPath) {
		if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(localPath)) {
			return (
				<ResourceImage
					path={localPath}
					projectId={resource.projectId}
					alt={typeof children === "string" ? children : "图片"}
					onOpenPath={resource.onOpenPath}
				/>
			);
		}
		return (
			<button
				className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
				onClick={() => void resource.onOpenPath?.(localPath)}
				type="button"
			>
				{children}
			</button>
		);
	}
	if (href && isExternalResourceLink(href)) return <ExternalMessageLink href={href}>{children}</ExternalMessageLink>;
	return (
		<a href={href} {...props}>
			{children}
		</a>
	);
};

const MessageMarkdownParagraph = ({ children, ...props }: ComponentProps<"p">) => <p {...props}>{children}</p>;

const PlainTextRenderer = ({ code }: { code: string }) => <PlainTextCodeBlock code={code} />;

const streamdownTranslations = {
  close: "关闭",
  copyLink: "复制链接",
  externalLinkWarning: "即将访问外部网站。",
  openExternalLink: "打开外部链接？",
  openLink: "打开链接",
};

const baseStreamdownPlugins: PluginConfig = {
	cjk,
	math,
	mermaid,
	renderers: [{ language: ["text", "plaintext"], component: PlainTextRenderer }],
};

const promptStreamdownPlugins: PluginConfig = { cjk };
const promptAllowedElements = ["p", "br", "ul", "ol", "li", "strong", "em", "del", "u"];

function streamdownPluginsFor(mode: MessageResponseProps["mode"], overrides?: PluginConfig): PluginConfig {
	const withoutCode = { ...(overrides ?? {}) };
	delete withoutCode.code;
	return mode === "streaming"
		? { ...baseStreamdownPlugins, ...withoutCode }
		: { ...baseStreamdownPlugins, ...withoutCode, code: projectCodeHighlighter };
}

export const MessageResponse: NamedExoticComponent<MessageResponseProps> = memo(
	({
		children,
		className,
		id,
		role,
		"aria-labelledby": ariaLabelledBy,
		onOpenPath,
		projectId,
		basePath,
		virtualize = false,
		components,
		mode = "static",
		plugins: callerPlugins,
		rehypePlugins: callerRehypePlugins,
		...streamdownProps
	}: MessageResponseProps): ReactElement => {
		const virtualized = virtualize && mode === "static" && typeof children === "string";
		const markdownBlocks = useMemo(
			() => (virtualized ? parseMarkdownIntoBlocks(children ?? "") : []),
			[children, virtualized],
		);
		const renderStreamdown = (content: string, contentClassName?: string) => (
			<Streamdown
				{...streamdownProps}
				className={cn(
					"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
					contentClassName,
				)}
				mode={virtualized ? "static" : mode}
				plugins={streamdownPluginsFor(virtualized ? "static" : mode, callerPlugins)}
				translations={streamdownTranslations}
				rehypePlugins={messageRehypePluginsFor(callerRehypePlugins)}
				components={
					{
						...components,
						img: MessageMarkdownImage,
						a: MessageMarkdownLink,
						p: MessageMarkdownParagraph,
					} as NonNullable<MessageResponseProps["components"]>
				}
			>
				{content}
			</Streamdown>
		);
		const response = virtualized ? (
			<div className={cn("h-full w-full", className)}>
				<Virtuoso
					data={markdownBlocks}
					increaseViewportBy={600}
					itemContent={(index, block) => (
						<div
							className="mx-auto w-full max-w-4xl px-1 py-2 sm:px-4 sm:py-4"
							data-markdown-block={index}
						>
							{renderStreamdown(block)}
						</div>
					)}
					style={{ height: "100%", width: "100%" }}
				/>
			</div>
		) : renderStreamdown(children ?? "", className);
		return (
			<ResourcePathContext.Provider value={{ onOpenPath, projectId, basePath }}>
				{id || role || ariaLabelledBy ? (
					<div id={id} role={role} aria-labelledby={ariaLabelledBy} className="contents">
						{response}
					</div>
				) : (
					response
				)}
			</ResourcePathContext.Provider>
		);
	},
	(prevProps, nextProps) =>
		prevProps.children === nextProps.children &&
		prevProps.mode === nextProps.mode &&
		prevProps.projectId === nextProps.projectId &&
		prevProps.basePath === nextProps.basePath &&
		prevProps.virtualize === nextProps.virtualize &&
		prevProps.id === nextProps.id &&
		prevProps.role === nextProps.role &&
		prevProps["aria-labelledby"] === nextProps["aria-labelledby"] &&
		nextProps.isAnimating === prevProps.isAnimating &&
		nextProps.onOpenPath === prevProps.onOpenPath,
);

MessageResponse.displayName = "MessageResponse";

export interface PromptResponseProps {
	className?: string;
	children?: string;
}

export function PromptResponse({ className, children }: PromptResponseProps): ReactElement {
	return (
		<Streamdown
			className={cn(
				"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				className,
			)}
			mode="static"
			plugins={promptStreamdownPlugins}
			controls={false}
			allowedElements={promptAllowedElements}
			allowedTags={{ u: [] }}
			unwrapDisallowed
		>
			{children}
		</Streamdown>
	);
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);
