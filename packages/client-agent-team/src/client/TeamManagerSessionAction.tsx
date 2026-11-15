import { useState, useSyncExternalStore } from 'react'
import { Button, IconNewChatOutlineRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamNavigationSource } from './slots.ts'

export interface TeamManagerSessionActionProps extends PropsRuntime<'conversation.session.header.actions'>, PropsLocale<'team'> {
  readonly navigation: TeamNavigationSource
  readonly newManagerSession: (expectedSessionId: SessionId) => Promise<void>
}

/** The manager header action replacing the preset label on the current manager Session. */
export function TeamManagerSessionAction({ navigation, newManagerSession, sessionId, t }: TeamManagerSessionActionProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  if (navigationState.manager !== true || navigationState.managerSessionId !== sessionId) return null

  const start = async (): Promise<void> => {
    setPending(true)
    setFailure(undefined)
    try {
      await newManagerSession(sessionId)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }
  return <>
    <Tooltip label={t('managerNewConversation')} side="bottom" delayMs={500} portal>
      <Button size="sm" variant="outline" icon={<IconNewChatOutlineRegular />} disabled={pending} onClick={() => { void start() }}>
        {pending ? t('managerStartingConversation') : t('managerNewConversation')}
      </Button>
    </Tooltip>
    {failure !== undefined && <Toast text={failure} holdMs={6000} onDone={() => { setFailure(undefined) }} />}
  </>
}
