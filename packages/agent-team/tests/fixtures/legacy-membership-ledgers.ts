/**
 * Frozen legacy ledgers the Host specs replay instead of committing.
 *
 * Both shapes here were written by builds that granted Project membership by
 * hand. Nothing writes them any more — membership is derived from
 * participation — so a spec that needs the old history loads it from this
 * module rather than committing it. They are replay fixtures, not API samples.
 */
/**
 * A frozen old ledger whose Member was enrolled into the Project by hand and
 * never wrote a word — the historical explicit membership that membership
 * derivation still has to keep visible.
 */
export const legacyJoinLedger = JSON.parse("{\"records\":[[\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",{\"sequence\":1,\"operationId\":\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",\"requestId\":\"agent-team:initialize:v1\",\"occurredAt\":\"2026-10-12T11:38:19.890Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":null,\"kind\":\"team/initialized\",\"data\":{\"humanMemberId\":\"member:human\"}}],[\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",{\"sequence\":2,\"operationId\":\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",\"requestId\":\"cap3-project\",\"occurredAt\":\"2026-10-12T11:38:19.892Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",\"kind\":\"team/project-created\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"project\":{\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"workspaceId\":\"workspace:alpha\",\"name\":\"engineering\",\"description\":\"\",\"createdAtSequence\":2,\"state\":\"active\"},\"memberIds\":[]}}],[\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",{\"sequence\":3,\"operationId\":\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",\"requestId\":\"add:member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"occurredAt\":\"2026-10-12T11:38:19.894Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",\"kind\":\"team/member-added\",\"data\":{\"member\":{\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"sessionId\":\"session:member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"workspaceId\":\"workspace:alpha\",\"handle\":\"silent3\",\"description\":\"Test Agent\",\"presetId\":\"team-member\",\"privateMemoryPath\":\"/tmp/member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"state\":\"enabled\"},\"projectRefs\":[]}}],[\"operation:ef94c3ad-2c33-4f80-95ea-649ad7b125ea\",{\"sequence\":4,\"operationId\":\"operation:ef94c3ad-2c33-4f80-95ea-649ad7b125ea\",\"requestId\":\"cap3-join\",\"occurredAt\":\"2026-10-12T11:38:19.894Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",\"kind\":\"team/project-member-added\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\"}}]],\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\"}") as {
  readonly records: Array<[string, unknown]>
  readonly projectRef: string
  readonly memberId: string
}
