import { useState } from "react"
import { SidebarProvider } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import pageMapping from "@/constants/page-mapping"
import { SettingsProvider } from "@/context/SettingsContext"
import { PushToTalkOverlay } from "@/components/push-to-talk-overlay"
import { CameraShareBootstrap } from "@/components/camera-share-bootstrap"

type PageKey = keyof typeof pageMapping

function Mainpage() {
    const [currentPage, setCurrentPage] = useState<PageKey>("llm")

    return (
        <SidebarProvider open={false} className="h-svh max-h-svh overflow-hidden">
            <SettingsProvider>
                    <AppSidebar onItemClick={setCurrentPage} activePage={currentPage} />
                    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden">
                        <main className="relative min-h-0 flex-1 overflow-hidden">
                            {Object.entries(pageMapping).map(([key, { page: PageComponent }]) => {
                                const isActive = currentPage === key;
                                const unmount = key === "memory";

                                // Keep inactive pages mounted but hidden; only memory remounts.
                                if (!unmount) {
                                    return (
                                        <div
                                            key={key}
                                            className="absolute inset-0 overflow-hidden"
                                            style={{
                                                visibility: isActive ? "visible" : "hidden",
                                                pointerEvents: isActive ? "auto" : "none",
                                                zIndex: isActive ? 1 : 0,
                                            }}
                                        >
                                            <PageComponent isActive={isActive} />
                                        </div>
                                    );
                                }

                                return isActive ? (
                                    <div key={key} className="absolute inset-0 overflow-auto">
                                        <PageComponent isActive={true} />
                                    </div>
                                ) : null;
                            })}
                        </main>
                        <CameraShareBootstrap />
                        <PushToTalkOverlay />
                    </div>
            </SettingsProvider>
        </SidebarProvider>
    );
}

export default Mainpage;