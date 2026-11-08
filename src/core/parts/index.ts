/** Every part of a message (`part.ts`), in one list that already names each: a part fills its own file. */
import { artifact } from "./artifact.ts";
import { artifacts } from "./artifacts.ts";
import { avatar } from "./avatar.ts";
import { connect } from "./connect.ts";
import { objects } from "./objects.ts";
import type { MessagePart } from "./part.ts";
import { reaction } from "./reaction.ts";

export { artifact, artifacts, avatar, connect, objects, reaction };

/** What a message of words carries besides them, to the owner or to a group's room. */
export const MESSAGE_PARTS: readonly MessagePart[] = [objects, artifacts];
