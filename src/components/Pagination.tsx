import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Reusable client-side pagination for any list. Returns the slice + a ready
 * `controls` JSX node so pages stay tidy.
 *
 * Usage:
 *   const { items, controls } = usePagination(allItems, 25);
 *   {items.map(...)}
 *   {controls}
 */
export function usePagination<T>(all: T[], pageSize = 25) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(all.length / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const items = useMemo(
    () => all.slice((page - 1) * pageSize, page * pageSize),
    [all, page, pageSize]
  );

  const pageNumbers = useMemo<(number | "…")[]>(() => {
    if (totalPages <= 1) return [];
    const out: (number | "…")[] = [];
    const win = 1;
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - win && i <= page + win)) {
        if (out[out.length - 1] !== i) out.push(i);
      } else if (i < page - win) {
        if (out[out.length - 1] !== "…") out.push("…");
        i = page - win - 1;
      } else if (i > page + win) {
        if (out[out.length - 1] !== "…") out.push("…");
        i = totalPages - 1;
      }
    }
    return out;
  }, [page, totalPages]);

  const controls =
    all.length > pageSize ? (
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1 mt-3">
        <p className="text-xs text-muted-foreground">
          Showing{" "}
          <span className="font-mono text-foreground">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, all.length)}
          </span>{" "}
          of <span className="font-mono text-foreground">{all.length}</span>
        </p>
        <div className="flex items-center gap-1">
          <Btn onClick={() => setPage(1)} disabled={page === 1} title="First">
            <ChevronsLeft className="w-3.5 h-3.5" />
          </Btn>
          <Btn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} title="Previous">
            <ChevronLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline ml-1">Prev</span>
          </Btn>
          <div className="flex items-center gap-1 mx-1">
            {pageNumbers.map((p, idx) =>
              p === "…" ? (
                <span key={`e-${idx}`} className="px-1 text-muted-foreground text-xs select-none">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={cn(
                    "min-w-[32px] h-8 px-2 rounded-md text-xs font-mono font-semibold transition-all",
                    p === page
                      ? "bg-gradient-to-br from-primary/30 to-neon-magenta/20 text-primary border border-primary/40 shadow-[0_0_14px_-2px_hsl(var(--primary)/0.5)]"
                      : "bg-white/[0.04] text-muted-foreground border border-white/[0.06] hover:text-foreground hover:bg-white/[0.08]"
                  )}
                >
                  {p}
                </button>
              )
            )}
          </div>
          <Btn onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} title="Next">
            <span className="hidden sm:inline mr-1">Next</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </Btn>
          <Btn onClick={() => setPage(totalPages)} disabled={page === totalPages} title="Last">
            <ChevronsRight className="w-3.5 h-3.5" />
          </Btn>
        </div>
      </div>
    ) : null;

  return { items, controls, page, setPage, totalPages };
}

const Btn = ({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      "h-8 px-2 inline-flex items-center rounded-md text-xs font-medium border transition-all",
      "bg-white/[0.04] border-white/[0.06] text-muted-foreground hover:text-foreground hover:bg-white/[0.08]",
      "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-white/[0.04]"
    )}
  >
    {children}
  </button>
);
