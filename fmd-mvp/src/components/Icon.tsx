import type { CSSProperties } from "react";
import { ICO, type IconName } from "../icons";

type Props = {
  name?: IconName;
  ico?: string;
  className?: string;
  title?: string;
  style?: CSSProperties;
};

export function Icon({ name, ico, className = "ico", title, style }: Props) {
  const mask = ico ?? (name ? ICO[name] : undefined);
  if (!mask) return null;
  return (
    <span
      className={className}
      title={title}
      style={{ ...style, ["--ico" as string]: mask }}
      aria-hidden={title ? undefined : true}
    />
  );
}
