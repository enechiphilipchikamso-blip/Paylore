import type { ButtonHTMLAttributes } from "react";

type BusyActionButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-busy"
> & {
  busy: boolean;
};

export function BusyActionButton({
  busy,
  disabled,
  ...buttonProps
}: BusyActionButtonProps) {
  return (
    <button
      {...buttonProps}
      aria-busy={busy || undefined}
      disabled={busy || Boolean(disabled)}
    />
  );
}
