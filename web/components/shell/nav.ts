export const navIndex = (items: { id: string }[], activeId: string) => items.findIndex((i) => i.id === activeId);

export const direction = (prevIndex: number, nextIndex: number): "up" | "down" => (nextIndex < prevIndex ? "up" : "down");
