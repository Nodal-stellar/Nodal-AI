"""
Exceptions raised by the Nodal AI client.
"""


class NodalAIClientError(Exception):
    """Base exception for all client errors."""

    def __init__(self, message: str, status_code: int | None = None, response_body: str | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


class NodalAIAuthError(NodalAIClientError):
    """Raised when the API returns 401 Unauthorized."""

    def __init__(self, message: str = "Unauthorized", response_body: str | None = None) -> None:
        super().__init__(message, status_code=401, response_body=response_body)


class NodalAINotFoundError(NodalAIClientError):
    """Raised when the API returns 404 Not Found."""

    def __init__(self, message: str = "Not found", response_body: str | None = None) -> None:
        super().__init__(message, status_code=404, response_body=response_body)


class NodalAIAPIError(NodalAIClientError):
    """Raised for any other non-2xx HTTP response."""

    def __init__(self, message: str, status_code: int, response_body: str | None = None) -> None:
        super().__init__(message, status_code=status_code, response_body=response_body)
