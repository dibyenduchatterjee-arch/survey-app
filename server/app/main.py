from fastapi import FastAPI

from app.api import admin, auth, exports, forms, openrosa, submissions

app = FastAPI(title="Evidence Action survey platform")
app.include_router(auth.router)
app.include_router(forms.router)
app.include_router(submissions.router)
app.include_router(openrosa.router)
app.include_router(exports.router)
app.include_router(admin.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
