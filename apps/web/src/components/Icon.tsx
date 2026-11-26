import * as Icons from 'lucide-react';

/** Lucide icon by its kebab-case name, e.g. "bed-double". Unknown names fall back to a dot. */
export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  const key = name.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()).replace(/-/g, '') as keyof typeof Icons;
  const C = (Icons[key] ?? Icons.Circle) as React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  return <C size={size} strokeWidth={1.75} className={className} />;
}
