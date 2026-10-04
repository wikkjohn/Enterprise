"use client";
import NextLink from "next/link";
import { type RenderLinkProps } from "@eaop/design-system";

/** Injects Next's client-side Link into design-system navigation components. */
export const renderLink = (p: RenderLinkProps) => <NextLink {...p} />;
