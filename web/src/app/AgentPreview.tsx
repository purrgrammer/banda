import type { AgentFileView } from "../../../src/server/api.ts";
import { Face } from "../chat/Face.tsx";
import { withoutFace } from "./agent-preview.ts";

/** Draw only geometry the daemon parsed and validated; invalid candidates cannot be accepted. */
export function AgentPreview({ file }: { file: Partial<AgentFileView> | undefined }) {
	if (!file) return null;
	if (!file.agent)
		return <p role="alert">This change isn't a valid agent. Ask for it to be corrected before allowing it.</p>;
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-3">
				<Face face={file.agent.face} name={file.agent.name} size="panel" />
				<span className="text-ui font-semibold">{file.agent.name}</span>
			</div>
			<p className="whitespace-pre-line">{withoutFace(file.text ?? "")}</p>
		</div>
	);
}
