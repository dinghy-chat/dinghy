import { createContext, useContext } from "react";

/** Space a scrolling tab needs to expose its last row above the floating tab bar. */
export const TabBarInsetContext = createContext(0);
export const useTabBarInset = () => useContext(TabBarInsetContext);
