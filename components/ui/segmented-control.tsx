import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
};

/**
 * A grouped set of mutually exclusive choices rendered as one control:
 * a recessed track with the active option raised out of it.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("wk-segmented border-border inline-flex shrink-0 items-center gap-1 rounded-lg border p-1", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-state={selected ? "checked" : "unchecked"}
            onClick={() => onChange(option.value)}
            className={cn(
              "wk-segmented-option rounded-md border border-transparent px-3 py-1.5 text-xs leading-none whitespace-nowrap",
              "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
