/** Every part of a message (`part.ts`), in one list that already names each: a part fills its own file. */
import { artifact } from "./artifact.ts";
import { avatar } from "./avatar.ts";
import { connect } from "./connect.ts";
import { objects } from "./objects.ts";
import type { MessagePart } from "./part.ts";
import { reaction } from "./reaction.ts";

export const MESSAGE_PARTS: readonly MessagePart[] = [reaction, artifact, connect, avatar, objects];
