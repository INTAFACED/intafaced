# svc-fix QuickFIX/J acceptor. Not the Node fleet image — Temurin 21 + QFJ 3.0.2.
# Pin: services/svc-fix/PIN.quickfixj commit 6334e2d288e5ec4f7503cef84281cc4c011e0062
# Maven 3.9.11 SHA matches scripts/ensure-toolchain.mjs. Never node-quickfix.

FROM eclipse-temurin:21-jdk-jammy AS build

ARG MAVEN_VERSION=3.9.11
ARG MAVEN_SHA512=bcfe4fe305c962ace56ac7b5fc7a08b87d5abd8b7e89027ab251069faebee516b0ded8961445d6d91ec1985dfe30f8153268843c89aa392733d1a3ec956c9978

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/maven.tgz \
      "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN_VERSION}/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    && echo "${MAVEN_SHA512}  /tmp/maven.tgz" | sha512sum -c - \
    && mkdir -p /opt/maven \
    && tar -xzf /tmp/maven.tgz -C /opt/maven --strip-components=1 \
    && rm /tmp/maven.tgz

# The OpenTelemetry Java agent (Apache-2.0), from Maven Central, checked against its published sha512.
# It traces the gateway's calls to matching; OTEL_JAVAAGENT_ENABLED (compose sets it from OTEL_ENABLED) turns it off.
ARG OTEL_JAVAAGENT_VERSION=2.33.1
ARG OTEL_JAVAAGENT_SHA512=279caaa5c366344235e93c3c89c8b3957e1c79693a68db83ef3cb3a0c390ac9f89a064d10896ff245ad4bb1e95d799b40f6c61315b41f5b04dced304c0b6c6c8
RUN mkdir -p /opt/otel \
    && curl -fsSL -o /opt/otel/opentelemetry-javaagent.jar \
      "https://repo.maven.apache.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/${OTEL_JAVAAGENT_VERSION}/opentelemetry-javaagent-${OTEL_JAVAAGENT_VERSION}.jar" \
    && echo "${OTEL_JAVAAGENT_SHA512}  /opt/otel/opentelemetry-javaagent.jar" | sha512sum -c -

ENV PATH=/opt/maven/bin:$PATH
WORKDIR /src

COPY services/svc-fix/pom.xml /src/pom.xml
COPY services/svc-fix/PIN.quickfixj /src/PIN.quickfixj
COPY services/svc-fix/src /src/src

RUN --mount=type=cache,target=/root/.m2 mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy
WORKDIR /app
COPY --from=build /src/target/svc-fix-0.0.0.jar /app/svc-fix.jar
COPY --from=build /src/PIN.quickfixj /app/PIN.quickfixj
COPY --from=build /opt/otel/opentelemetry-javaagent.jar /app/opentelemetry-javaagent.jar
USER nobody
# Compose may replace CMD. Main-Class is io.intafaced.fix.FixAcceptorMain.
CMD ["java", "-javaagent:/app/opentelemetry-javaagent.jar", "-cp", "/app/svc-fix.jar", "io.intafaced.fix.FixAcceptorMain"]
