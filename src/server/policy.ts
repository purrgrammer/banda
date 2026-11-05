/**
 * What the app's frames may load (DESIGN.md "The app"), in the policy the daemon serves the app with and the one the dev
 * server does: nothing. A page's frame is a sandboxed `srcdoc`, which no request loads, so it still renders and its
 * inline interactions work; a link that would navigate the frame elsewhere is refused. Here, alone, so the
 * Vite config can import it.
 */
export const FRAME_POLICY = "frame-src 'none'";
