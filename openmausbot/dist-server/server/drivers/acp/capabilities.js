export function acpCapabilities(support) {
    return {
        sessionModelSwitch: "unsupported",
        agentsMcp: true,
        customMcp: true,
        computerMcp: true,
        composioMcp: true,
        browserMcp: true,
        dataMcp: true, emailMcp: true, deviceMcp: true,
        images: support.images !== false,
        nativeImageInput: support.images === true,
        effortLevels: support.effortLevels,
        modelVariants: support.modelVariants === true,
        localComputerMcp: true,
        contextReading: "meter",
        engineAdmission: true, ...(support.askTool ? { askTool: { kind: "native", name: support.askTool } } : {}),
        ...(support.steer ? { queueing: true } : {}),
        strictResume: true,
    };
}
