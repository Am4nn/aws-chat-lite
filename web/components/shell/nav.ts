/** Content enters from the direction the user moved through the list. */
export const direction = (prevIndex: number, nextIndex: number): "up" | "down" => (nextIndex < prevIndex ? "up" : "down");
