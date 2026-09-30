import type { SVGProps } from 'react';
import { cx } from './utils';

/** 16x16 stroke icons; kept inline so the kit has no asset dependencies. */
const PATHS = {
  chevron: 'M4.5 6.5 8 10l3.5-3.5',
  'chevron-left': 'M9.5 4.5 6 8l3.5 3.5',
  'chevron-right': 'M6.5 4.5 10 8l-3.5 3.5',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  check: 'M3.5 8.5l3 3 6-7',
  copy: 'M5.5 5.5h6v7h-6zM3.5 10.5v-7h6',
  reset: 'M4 8a4.2 4.2 0 1 0 1.4-3.1M4 3.2v2.4h2.4',
  up: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  down: 'M8 3.5v9M4.5 9 8 12.5 11.5 9',
  grip: 'M6 4v.01M10 4v.01M6 8v.01M10 8v.01M6 12v.01M10 12v.01',
  duplicate: 'M4.5 4.5h5v5h-5zM7.5 11.5h4v-4',
  reverse: 'M3.5 6h9l-2.5-2.5M12.5 10h-9l2.5 2.5',
  paste: 'M6 3.5h4v2H6zM4.5 4.5h-.5v8h8v-8h-.5M6.5 8.5h3M6.5 10.5h3',
  search: 'M7 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM10.4 10.4l3 3',
  panel: 'M2.5 3.5h11v9h-11zM6.5 3.5v9',
  info: 'M8 7.2v4M8 4.8v.01',
  upload: 'M8 10.5v-7M5 6.2 8 3.2l3 3M3.5 11.5v1h9v-1',
  download: 'M8 3.5v7M5 7.8l3 3 3-3M3.5 12.5h9',
  warning: 'M8 3 13.5 12.5h-11zM8 6.8v2.7M8 11v.01',
  trash: 'M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 7.5h5L11 5',
  play: 'M5.5 3.8v8.4l6.8-4.2z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  eye: 'M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8zM8 9.7a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4z',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 14, className, ...rest }: IconProps) {
  return (
    <svg
      className={cx('lcui-icon', className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
