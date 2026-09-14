import {
  QueryError as SharedQueryError,
  type QueryErrorProps,
} from "@workspace/web-ui/query-error";
import { userErrorMessage } from "@/lib/errors";

// Keep the console's display-error policy without duplicating the shared UI.
export function QueryError({ detail, ...props }: QueryErrorProps) {
  return (
    <SharedQueryError
      {...props}
      detail={
        detail
          ? (userErrorMessage({ data: { error: detail } }) ?? detail)
          : detail
      }
    />
  );
}
