import { type ReactNode } from "react";

export interface RenderLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  "aria-current"?: "page" | "true";
  onClick?: () => void;
}

/** Inject a router link (e.g. Next.js `Link`): `renderLink={(p) => <Link {...p} />}` */
export type RenderLink = (props: RenderLinkProps) => ReactNode;

export const defaultRenderLink: RenderLink = ({ href, className, children, onClick, ...rest }) => (
  <a href={href} className={className} onClick={onClick} {...rest}>
    {children}
  </a>
);
