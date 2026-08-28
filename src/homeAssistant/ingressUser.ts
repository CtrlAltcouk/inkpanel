import type { Request, Response } from 'express';
import type { DashboardWidget } from '../widgets/registry.ts';
import { z } from 'zod';

const noControls = /^[^\x00-\x1f\x7f-\x9f]*$/;
export const homeAssistantUserIdSchema = z.string().min(1).max(128).regex(noControls)
  .refine((value) => value === value.trim(), 'invalid user ID');
const nameSchema = z.string().max(256).regex(noControls).transform((value) => value.trim() || null);
export const homeAssistantUserSchema = z.strictObject({
  id: homeAssistantUserIdSchema,
  username: nameSchema.nullable(),
  displayName: nameSchema.nullable(),
});
export type HomeAssistantIngressUser = z.infer<typeof homeAssistantUserSchema>;

/** Call only with the result of the listener's Supervisor-address gate. LAN
 * headers are deliberately never parsed, including on firmware requests. */
export function parseIngressUser(req: Pick<Request, 'headers'>, trustedIngress: boolean): HomeAssistantIngressUser | null {
  if (!trustedIngress) return null;
  const parsed = homeAssistantUserSchema.safeParse({
    id: req.headers['x-remote-user-id'],
    username: req.headers['x-remote-user-name'] ?? null,
    displayName: req.headers['x-remote-user-display-name'] ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/** LAN remains the existing admin/firmware surface. Personal Ingress reads and
 * writes must have an identity, even when the proxy address is trusted. */
export function authorizePersonalTodoAccess(widgets: readonly DashboardWidget[], res: Response): boolean {
  if (res.locals.homeAssistantIngress && !res.locals.homeAssistantUser
    && widgets.some((widget) => widget.type === 'todo' && 'ownerUserId' in widget.config)) {
    res.status(403).json({ error: 'Valid trusted Home Assistant user identity required' });
    return false;
  }
  return true;
}
