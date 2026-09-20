import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { Workspace } from '../../auth/actor';
import { requireInternalSecret } from '../internal-headers';

/**
 * Who asked, according to the service that knows.
 *
 * A reservation is raised against a CRM task, on a CRM project, and the project
 * says which company's work it is. That is the authoritative answer to "who
 * requested this", and it is the only one: the request body also carries an
 * `entityId`, and across the 83 reservations here it is empty 28
 * times and, where it is present and checkable, agrees with the project 46
 * times, names the company that OWNS the stock 3 times, and names neither 6
 * times. A field that means three different things depending on the row is a
 * label, not an answer.
 *
 * So this asks CRM, once, at the moment the reservation is made, and the answer
 * is pinned to the row. Pinning matters: a project that moves to another company
 * next year did not retroactively change who asked for a drill last March.
 *
 * A project that no longer exists answers `null` rather than throwing. Twelve
 * reservations here already point at deleted projects, and "we cannot tell" is
 * the truthful thing to record about them.
 */
/** What a person is told when CRM cannot be asked whose work this is. */
const CRM_UNREACHABLE = 'Առաջադրանքների ծառայությունը հասանելի չէ, փորձեք մի փոքր ուշ';

@Injectable()
export class RequesterWorkspaceService {
  private readonly logger = new Logger(RequesterWorkspaceService.name);

  private get crmUrl(): string {
    return process.env.CRM_API_URL || 'http://localhost:3003';
  }

  private get secret(): string {
    return requireInternalSecret();
  }

  /**
   * The company whose work this project is, or `null` when CRM cannot say.
   *
   * `null` covers two situations — no such project, and a project filed
   * under no company — which mean the same thing to the caller: nobody may be
   * authorized on the strength of this. CRM being unreachable is a third thing
   * and is NOT folded in (2026-09-20): it still authorizes nobody, but it is
   * reported as an outage, because the caller used to turn it into "this
   * request is not linked to a project", which was false and sent people
   * looking for a problem in their own request.
   */
  async ofProject(projectId: number | null | undefined): Promise<Workspace> {
    if (!Number.isInteger(projectId) || Number(projectId) <= 0) return null;
    try {
      const res = await fetch(`${this.crmUrl}/api/projects/${projectId}/workspace/internal`, {
        headers: { 'x-internal-secret': this.secret },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(`CRM project ${projectId} workspace lookup failed: ${res.status}`);
        throw new ServiceUnavailableException(CRM_UNREACHABLE);
      }
      const body = (await res.json()) as { found?: boolean; entityId?: number | null };
      if (!body?.found) {
        this.logger.warn(`CRM has no project ${projectId}; requester workspace unknown`);
        return null;
      }
      const entityId = Number(body.entityId);
      return Number.isInteger(entityId) && entityId > 0 ? entityId : null;
    } catch (e: unknown) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.warn(`CRM project ${projectId} workspace lookup error: ${(e as Error)?.message}`);
      throw new ServiceUnavailableException(CRM_UNREACHABLE);
    }
  }

  /**
   * The company behind a task, when a request names a task and not a project.
   * One hop further: the task says which project it is on, the project says
   * whose work it is.
   */
  async ofTask(taskId: number | null | undefined): Promise<Workspace> {
    if (!Number.isInteger(taskId) || Number(taskId) <= 0) return null;
    try {
      const res = await fetch(`${this.crmUrl}/api/project-tasks/${taskId}/internal`, {
        headers: { 'x-internal-secret': this.secret },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(`CRM task ${taskId} lookup failed: ${res.status}`);
        throw new ServiceUnavailableException(CRM_UNREACHABLE);
      }
      const task = (await res.json()) as { projectId?: number };
      return this.ofProject(task?.projectId);
    } catch (e: unknown) {
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.warn(`CRM task ${taskId} lookup error: ${(e as Error)?.message}`);
      throw new ServiceUnavailableException(CRM_UNREACHABLE);
    }
  }

  /**
   * What a reservation being created should record as its requester.
   *
   * The project first, because it is one call rather than two and the CRM task
   * screen always sends it; the task as a fallback for a caller that names only
   * the task. Never the request body's `entityId`, which is why that argument is
   * not accepted here at all.
   */
  async forRequest(input: { projectId?: number | null; taskId?: number | null }): Promise<Workspace> {
    const fromProject = await this.ofProject(input.projectId);
    if (fromProject !== null) return fromProject;
    return this.ofTask(input.taskId);
  }
}
