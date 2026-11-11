"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { isAdmin, type ModelOption, type ModelPick, type RoomView } from "../types";

type Models = {
  roomId: string;
  models: ModelOption[];
  roomDefault: ModelPick;
  canSetDefault: boolean;
  picks: Record<string, ModelPick>;
  pick: (chatId: string, model: ModelPick) => void;
};

const ModelsContext = createContext<Models | null>(null);

export function useModels(): Models {
  const models = useContext(ModelsContext);
  if (!models) throw new Error("useModels needs a ModelsProvider");
  return models;
}

/**
 * The room's models and default, from the server's view (fetched again on every `room.updated`), and what each chat
 * picked. A pick lives only in memory: it resets to the room default on reload.
 */
export function ModelsProvider({ view, children }: { view: RoomView; children: ReactNode }) {
  const [picks, setPicks] = useState<Record<string, ModelPick>>({});
  const pick = useCallback((chatId: string, model: ModelPick) => setPicks((p) => ({ ...p, [chatId]: model })), []);
  const value: Models = {
    roomId: view.room.roomId, models: view.models, roomDefault: view.defaultModel,
    canSetDefault: isAdmin(view.me.role) && !view.room.archived, picks, pick,
  };
  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}

/** The chat's model: the room default until someone here picks one. */
export function useModelPick(chatId: string): [ModelPick, (model: ModelPick) => void] {
  const { picks, roomDefault, pick } = useModels();
  return [picks[chatId] ?? roomDefault, useCallback((model: ModelPick) => pick(chatId, model), [pick, chatId])];
}
