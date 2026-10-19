package io.intafaced.fix;

import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import quickfix.Message;

/**
 * In-process fanout from streamable sources to the drop-copy session.
 * Included lists sources that actually published to a listener. Missing sources refuse.
 * No invented executions. No ledger.
 */
public final class DropCopyHub {
    private final List<FixDropCopyApplication> listeners = new CopyOnWriteArrayList<>();
    private final Set<String> published = ConcurrentHashMap.newKeySet();

    public void attach(FixDropCopyApplication listener) {
        if (listener != null) {
            listeners.add(listener);
        }
    }

    public DropCopyPublishResult publish(String source, Message execution) {
        if (execution == null) {
            return DropCopyPublishResult.refuse(
                    "dropcopy_source_missing", "execution is missing; svc-fix does not synthesize a drop-copy fill");
        }
        if (!DropCopyCatalog.streamable(source)) {
            String name = source == null || source.isBlank() ? "unknown" : source;
            List<String> included = included();
            List<String> missing = DropCopyCatalog.missingOf(published);
            return DropCopyPublishResult.refuse(
                    "dropcopy_source_missing",
                    "source "
                            + name
                            + " is not included; included=["
                            + String.join(",", included)
                            + "]; missing=["
                            + String.join(",", missing)
                            + "]; svc-fix does not synthesize missing sources");
        }
        int delivered = 0;
        for (FixDropCopyApplication listener : listeners) {
            listener.deliver(execution);
            delivered++;
        }
        if (delivered == 0) {
            return DropCopyPublishResult.refuse(
                    "dropcopy_not_delivered",
                    "execution was not delivered to a drop-copy listener; svc-fix does not report the fill as published");
        }
        published.add(source);
        return DropCopyPublishResult.streamed(delivered);
    }

    public List<String> included() {
        return DropCopyCatalog.includedOf(published);
    }

    public DropCopyCompleteness claimComplete() {
        return DropCopyCatalog.claimComplete(published);
    }

    public static DropCopyHub disabled() {
        return new DropCopyHub();
    }
}
