"use client";

import { Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "cn";

type RoadsUsedSwitchProps = {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  onCheckedChange: (checked: boolean) => void;
  "aria-label"?: string;
};

export function RoadsUsedSwitch({
  id,
  checked,
  disabled,
  loading = false,
  onCheckedChange,
  "aria-label": ariaLabel,
}: RoadsUsedSwitchProps) {
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        className={cn(loading && "opacity-35")}
      />
      {loading && (
        <Loader2
          className="pointer-events-none absolute size-3.5 animate-spin text-[#5c5348]"
          aria-hidden
        />
      )}
    </span>
  );
}
