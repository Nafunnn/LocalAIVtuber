import { useState } from "react";
import SessionList from "@/components/session-list";
import DocumentList from "@/components/document-list";
import UserModelPanel from "@/components/user-model-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function MemoryPage() {
    const [tab, setTab] = useState("profile");

    return (
        <div className="h-full overflow-y-auto">
            <Tabs value={tab} onValueChange={setTab} className="h-full">
                <div className="border-b px-5 pt-4">
                    <TabsList>
                        <TabsTrigger value="profile">User profile</TabsTrigger>
                        <TabsTrigger value="sessions">Chat sessions</TabsTrigger>
                        <TabsTrigger value="documents">Documents</TabsTrigger>
                    </TabsList>
                </div>
                <TabsContent value="profile" className="mt-0">
                    <UserModelPanel />
                </TabsContent>
                <TabsContent value="sessions" className="mt-0">
                    <SessionList />
                </TabsContent>
                <TabsContent value="documents" className="mt-0">
                    <DocumentList />
                </TabsContent>
            </Tabs>
        </div>
    );
}

export default MemoryPage;
