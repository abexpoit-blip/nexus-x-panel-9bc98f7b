import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { TableSkeleton } from "./TableSkeleton";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

interface Column<T> {
  key: string;
  header: string;
  render?: (row: T, index: number) => React.ReactNode;
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  className?: string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyText?: string;
  /** Items per page. Set to 0 / null to disable pagination. Defaults to 25. */
  pageSize?: number | null;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  data,
  className,
  onRowClick,
  loading,
  emptyText = "No data available",
  pageSize = 25,
}: DataTableProps<T>) {
  const [page, setPage] = useState(1);
  const usePagination = !!pageSize && pageSize > 0;

  const totalPages = useMemo(
    () => (usePagination ? Math.max(1, Math.ceil(data.length / (pageSize as number))) : 1),
    [data.length, pageSize, usePagination]
  );

  // Clamp page when data shrinks (e.g. filter applied)
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const visible = useMemo(() => {
    if (!usePagination) return data;
    const start = (page - 1) * (pageSize as number);
    return data.slice(start, start + (pageSize as number));
  }, [data, page, pageSize, usePagination]);

  if (loading && data.length === 0) {
    return <TableSkeleton rows={6} cols={columns.length} className={className} />;
  }

  // Build a compact page-number list with ellipses (e.g. 1 … 4 5 [6] 7 8 … 20)
  const pageNumbers = useMemo<(number | "…")[]>(() => {
    if (!usePagination || totalPages <= 1) return [];
    const out: (number | "…")[] = [];
    const window = 1;
    const add = (n: number | "…") => {
      if (out[out.length - 1] !== n) out.push(n);
    };
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1 || i === totalPages || (i >= page - window && i <= page + window)) {
        add(i);
      } else if (i < page - window) {
        add("…");
        i = page - window - 1;
      } else if (i > page + window) {
        add("…");
        i = totalPages - 1;
      }
    }
    return out;
  }, [page, totalPages, usePagination]);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto scrollbar-none">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/[0.08]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={cn(
                      "px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider",
                      col.className
                    )}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    "border-b border-white/[0.04] hover:bg-white/[0.04] transition-colors",
                    onRowClick && "cursor-pointer"
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-4 py-3 text-sm text-foreground", col.className)}>
                      {col.render ? col.render(row, (page - 1) * (pageSize || 0) + i) : row[col.key]}
                    </td>
                  ))}
                </tr>
              ))}
              {data.length === 0 && !loading && (
                <tr>
                  <td colSpan={columns.length} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    {emptyText}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {usePagination && data.length > (pageSize as number) && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-1">
          <p className="text-xs text-muted-foreground">
            Showing{" "}
            <span className="font-mono text-foreground">
              {(page - 1) * (pageSize as number) + 1}–
              {Math.min(page * (pageSize as number), data.length)}
            </span>{" "}
            of <span className="font-mono text-foreground">{data.length}</span>
          </p>
          <div className="flex items-center gap-1">
            <PageBtn onClick={() => setPage(1)} disabled={page === 1} title="First">
              <ChevronsLeft className="w-3.5 h-3.5" />
            </PageBtn>
            <PageBtn onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} title="Previous">
              <ChevronLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline ml-1">Prev</span>
            </PageBtn>
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
            <PageBtn onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} title="Next">
              <span className="hidden sm:inline mr-1">Next</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </PageBtn>
            <PageBtn onClick={() => setPage(totalPages)} disabled={page === totalPages} title="Last">
              <ChevronsRight className="w-3.5 h-3.5" />
            </PageBtn>
          </div>
        </div>
      )}
    </div>
  );
}

const PageBtn = ({
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
