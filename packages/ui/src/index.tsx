import { PanelsTopLeft } from "lucide-react";
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark">
        <PanelsTopLeft size={21} />
      </span>
      {!compact && (
        <span>
          device<span className="brand-light">deck</span>
        </span>
      )}
    </span>
  );
}
