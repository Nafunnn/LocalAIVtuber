import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"
import { cn } from "@/lib/utils"

interface ChatMarkdownProps {
    content: string
    className?: string
}

const markdownComponents: Components = {
    p: ({ children }) => (
        <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
    ),
    h1: ({ children }) => (
        <h1 className="mb-2 mt-3 first:mt-0 text-base font-semibold tracking-tight">{children}</h1>
    ),
    h2: ({ children }) => (
        <h2 className="mb-2 mt-3 first:mt-0 text-sm font-semibold tracking-tight">{children}</h2>
    ),
    h3: ({ children }) => (
        <h3 className="mb-1.5 mt-2 first:mt-0 text-sm font-medium">{children}</h3>
    ),
    ul: ({ children }) => (
        <ul className="mb-2 last:mb-0 list-disc space-y-1 pl-5">{children}</ul>
    ),
    ol: ({ children }) => (
        <ol className="mb-2 last:mb-0 list-decimal space-y-1 pl-5">{children}</ol>
    ),
    li: ({ children }) => (
        <li className="leading-relaxed">{children}</li>
    ),
    blockquote: ({ children }) => (
        <blockquote className="mb-2 last:mb-0 border-l-2 border-border/80 pl-3 text-muted-foreground italic">
            {children}
        </blockquote>
    ),
    code: ({ className, children, ...props }) => {
        const isBlock = Boolean(className)
        if (isBlock) {
            return (
                <code className={cn("font-mono text-[0.85em]", className)} {...props}>
                    {children}
                </code>
            )
        }
        return (
            <code
                className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em]"
                {...props}
            >
                {children}
            </code>
        )
    },
    pre: ({ children }) => (
        <pre className="mb-2 last:mb-0 overflow-x-auto rounded-md bg-background/70 p-3 font-mono text-[0.85em] leading-relaxed">
            {children}
        </pre>
    ),
    a: ({ href, children }) => (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2 hover:opacity-80"
        >
            {children}
        </a>
    ),
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    hr: () => <hr className="my-3 border-border/70" />,
    table: ({ children }) => (
        <div className="mb-2 last:mb-0 overflow-x-auto">
            <table className="w-full border-collapse text-left text-[0.9em]">{children}</table>
        </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border/70">{children}</thead>,
    th: ({ children }) => <th className="px-2 py-1 font-semibold">{children}</th>,
    td: ({ children }) => <td className="border-t border-border/50 px-2 py-1 align-top">{children}</td>,
}

export default function ChatMarkdown({ content, className }: ChatMarkdownProps) {
    return (
        <div className={cn("chat-markdown break-words", className)}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {content}
            </ReactMarkdown>
        </div>
    )
}
